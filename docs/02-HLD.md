# High Level Design — FortiGate HA on AWS

> Diagram: [`docs/diagrams/02-HLD-fortigate-ha.drawio`](diagrams/02-HLD-fortigate-ha.drawio)
> (recreated 2026-06-09 — current 4-port / 8-subnet / bastion topology).
> Open in [diagrams.net](https://app.diagrams.net) to edit; export a fresh PNG to refresh
> the embedded image below (the `.png` still shows the old 3-port layout).

---

## Design thesis

Prove **FortiGate FGCP Active-Passive failover across two AWS AZs, end-to-end and
automatically**: IaC deploys the cluster, a fault is injected (terminate the active
node), and a hexagonal validator confirms the cluster Elastic IP migrated to the
surviving unit. Everything then auto-destroys.

Across two AZs there is no L2 (no multicast, no shared MAC), so failover is **100%
API-driven**: the FGCP callback calls `ec2:AssociateAddress` (move the EIP) and
`ec2:ReplaceRoute` (repoint both private route tables). This makes the AWS SDN
connector + dedicated heartbeat the hard requirements of the design.

**Key lesson baked into the design — management does NOT fail over.** The MGMT
service does not follow the active unit, and Port2 (data-plane) does not reliably
answer management on a standby unit. Management lives on **Port4 (HA-MGMT)**: a
dedicated interface active on *both* units at all times, with a per-unit EIP for
independent EC2-API egress. See [`lessons-learned.md`](lessons-learned.md) #8/#9/#10.

---

## Topology overview

![FortiGate HA Topology — AWS Multi-AZ Active/Passive FGCP](diagrams/02-HLD-fortigate-ha-2.png)

**Key design points:**

- **Internet → IGW → Port1 (WAN):** Public ingress. The cluster EIP is attached to
  **FGT-Active's Port1-A**; on failover it migrates to Port1-B via `ec2:AssociateAddress`.
- **Port2 (data / internal):** Default route on the private subnets points to whichever
  unit is **Active**; on failover the route tables update via `ec2:ReplaceRoute`.
- **Port3 (HA heartbeat):** FGCP **unicast** heartbeat + session sync, cross-AZ. The
  heartbeat SG must allow *all traffic between members* — not just port 703 (see below).
- **Port4 (HA-MGMT):** Dedicated management, active on both units, per-unit EIP. The
  reliable path for admin and diagnostics.
- **Two AZs:** FGT-Active (priority 200) in AZ-1a; FGT-Passive (priority 100) in AZ-1b.

---

## Components

### CDK stacks (4)

| Stack | Resources | Purpose |
|---|---|---|
| **NetworkStack** | VPC, 8 subnets, IGW, route tables, 4 SGs | Network foundation |
| **FortiGateStack** | 2× EC2 `c6in.xlarge`, 8 ENIs, EIPs, IAM role, UserData | HA pair |
| **BastionStack** | t3.micro (SSM), S3 bucket, ingress to Port2/Port4 | In-VPC validator + SSH diagnostics vantage |
| **WatchdogStack** | EventBridge rule (30 min), Lambda, CodeBuild | Auto-destroy cost guard |

### Network — VPC `10.0.0.0/16`

| Subnet | CIDR | AZ | Port | Purpose |
|---|---|---|---|---|
| public-1a | 10.0.1.0/24 | a | Port1 | WAN / internet (cluster EIP) |
| private-1a | 10.0.2.0/24 | a | Port2 | data / internal |
| ha-1a | 10.0.3.0/24 | a | Port3 | HA heartbeat |
| mgmt-1a | 10.0.4.0/24 | a | Port4 | HA-MGMT (per-unit EIP) |
| public-1b | 10.0.11.0/24 | b | Port1 | WAN / internet |
| private-1b | 10.0.12.0/24 | b | Port2 | data / internal |
| ha-1b | 10.0.13.0/24 | b | Port3 | HA heartbeat |
| mgmt-1b | 10.0.14.0/24 | b | Port4 | HA-MGMT (per-unit EIP) |

Both **private-1a/1b** route tables point `0.0.0.0/0` → Port2 of the current Active;
the FGCP callback updates both via `ec2:ReplaceRoute` on failover. Public + mgmt
subnets route to the IGW (Port4 needs EC2-API egress for the SDN connector).

### Security Groups (4)

| SG | Inbound | Purpose |
|---|---|---|
| **sg-wan** | TCP 443, UDP 500/4500, ICMP from `0.0.0.0/0` | Port1 / WAN |
| **sg-mgmt** | TCP 443, TCP 22 from `adminCidr` | Port2 / admin |
| **sg-ha** | **ALL traffic from sg-ha itself (self-referencing)** | Port3 / FGCP heartbeat + sync |
| **sg-ha-mgmt** | TCP 443, TCP 22, ICMP from `adminCidr`; outbound 443 to EC2 API | Port4 / HA-MGMT |

> ⚠️ **sg-ha must NOT be scoped to TCP/UDP 703.** 703 is session-sync; the FGCP
> heartbeat is protocol-level (EtherType 0x8890/0x8891/0x8893, encapsulated for
> unicast). A port-scoped rule drops it and the cluster never forms — the project's
> root-cause bug (lesson #8). Both Port3 ENIs share sg-ha, so a self-referencing
> allow-all keeps it open only between members.

### FortiGate instances

| Property | Value |
|---|---|
| Instance type | `c6in.xlarge` (4 vCPU / 8 GiB) — Fortinet recommended default |
| AMI | Dynamic lookup — owner `679593333241`, pattern `FortiGate-VM64-AWSONDEMAND*` |
| Licensing | PAYG (Marketplace). Accept terms before first deploy (lesson #6). |
| ENIs per instance | 4 (Port1 WAN, Port2 data, Port3 HA, Port4 HA-MGMT) — all `sourceDestCheck: false`; attached at launch |
| EIPs | 1 cluster VIP on Port1-A (tagged, fails over) + 1 per-unit mgmt EIP on each Port4 (untagged, static) |
| HA mode | FGCP Active/Passive, **unicast**, with `ha-mgmt-interfaces` on Port4 |
| HA priorities | Active = 200, Passive = 100 |
| Admin | password set in UserData; access on Port2 + Port4 (`allowaccess https ssh`) |

### Bastion (diagnostics vantage)

SSM-managed t3.micro inside the VPC. Runs the validator (needs the active node's Port2
private IP) and the SSH diagnostics (Port4 reliable, Port2 fallback). No SSH key, no
inbound SG; ingress to Port2/Port4 is granted from `sg-bastion` only.

### Watchdog (auto-destroy)

EventBridge `rate(30 minutes)` → Lambda → CodeBuild runs `cdk destroy --all --force --ci`.
Backup to the `trap cleanup EXIT` in `deploy-and-test.sh` — infra is destroyed even if
the shell is killed.

---

## Failover sequence

```
1. FGT-Active fails (terminated / EC2 stop)
2. FGT-Passive detects loss of heartbeat on Port3 (unicast, ~seconds)
3. FortiOS elects the new Active and the AWS SDN connector (awsd) calls:
   a. ec2:DisassociateAddress  — release the cluster EIP from Port1-A's ENI
   b. ec2:AssociateAddress     — attach it to Port1-B            ← public traffic follows
   c. ec2:ReplaceRoute (×2)    — private-1a + private-1b → Port2-B ← internal routing follows
4. Validator (on the bastion) polls:
   - CloudQueryPort → ec2:DescribeInstances / EIP ownership
   - Gate: EipMigrationInvariant must pass (surviving unit holds the EIP) → PASSED ✅
   - Informational: Port2 HTTPS reachability (data-plane; not a gate)
5. ha-test.sh captures layered diagnostics (console, SSH on Port4, CloudTrail)
6. deploy-and-test.sh exits → trap runs cdk destroy
```

Detection-to-EIP-migration target: **< 120 s** (NFR). Observed: poll #1 (< 10 s).

---

## IAM role (failover permissions)

```
ec2:Describe*                  # all discovery calls the SDN connector needs
ec2:AssociateAddress
ec2:DisassociateAddress        # release the EIP from the terminated unit's ENI first
ec2:AssignPrivateIpAddresses
ec2:UnassignPrivateIpAddresses
ec2:ReplaceRoute
```

`resources: ['*']` — EC2 describe/associate calls do not support resource-level
restriction. IAM only matters once the cluster forms (lesson #9).

---

## Key architectural decisions

| RFC | Decision | Why |
|---|---|---|
| RFC-001 | Prove cross-AZ FGCP failover via EIP migration; management on **Port4 (HA-MGMT)** | MGMT service has no failover coverage; Port2 (data) is unreliable on standby — Port4 is always up on both units |
| RFC-002 | CDK TypeScript | Type-safe IaC, programmable (AMI lookup, CDK assertions) |
| RFC-003 | PAYG licensing | No friction for a short-lived lab; BYOL is cost-rational for production |
| RFC-004 | FGCP Active/Passive (not GWLB) | The failover + mgmt lessons only manifest in A/P FGCP |
| RFC-005 | Hexagonal validator | Enables TDD; domain logic is pure and fast to test without AWS |
| RFC-006 | Watchdog Lambda + bash trap | Dual cleanup — robust against shell kills and long failures |
| —       | Self-referencing sg-ha (all traffic between members) | FGCP heartbeat is not TCP/UDP 703; a port-scoped rule breaks cluster formation (lesson #8) |
| —       | Layered diagnostics + pre-flight gate | Instrument before theorizing — runtime ground truth beats AWS-API inference (lesson #9) |
