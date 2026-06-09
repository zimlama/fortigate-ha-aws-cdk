# Architecture Decision Records — fortigate-ha-aws-cdk

> Formal decisions. RFC-001–006 were made before writing code; RFC-007–008 were added
> after implementation surfaced the real failure modes (honest engineering record).
> Format: Context → Decision → Consequences → Alternatives Rejected.

---

## RFC-001 — Prove cross-AZ FGCP failover; management on Port4 (HA-MGMT)

**Status:** Accepted (revised 2026-06-09 — see "Revision" below)  
**Date:** 2026-06-03

### Context

FortiGate HA uses the FGCP protocol to elect a new Active node. On failover FortiOS's
AWS SDN connector calls the EC2 API to (1) reassociate the cluster Elastic IP to the new
Active's Port1, and (2) update the private route tables to the new Active's Port2. Across
two AZs there is no L2, so this API callback is the *only* failover mechanism — making it
the thing worth proving end-to-end.

The **MGMT service does not follow the active unit**. The original plan was to put admin
access on Port2 (a data-plane interface covered by the route-table update). Testing
disproved that: Port2 does not reliably answer management on a not-yet-promoted / standby
unit, even when AWS reports the ENI as up.

### Decision

1. The project's thesis and pass/fail gate is **EIP migration** — the validator proves the
   cluster EIP moves to the surviving unit on failover.
2. Management lives on **Port4 (HA-MGMT)** — a dedicated interface, active on *both* units
   at all times, with a per-unit EIP for independent EC2-API egress. `allowaccess https ssh`
   is set on Port4 (and on Port2 for in-VPC data-side admin), and the FortiOS
   `ha-mgmt-interfaces` feature binds management to Port4.
3. Port2 HTTPS reachability is kept as **informational** telemetry, not a gate.

### Revision (2026-06-09)

The original decision ("admin on Port2, not MGMT") was **partially wrong and has been
corrected**. Port2 is data-plane and unreliable on standby; Port4 (HA-MGMT) is the correct
management path. Kept here as an honest engineering record — see `lessons-learned.md`
#9/#10. The deeper failure that blocked all of this was the heartbeat SG (see RFC-007).

### Consequences

**Positive:**
- Management is reachable on both units regardless of FGCP state (Port4 is always up).
- EIP migration is an unambiguous, API-observable proof of failover.

**Negative:**
- Port4 adds a 4th ENI/subnet per unit and a per-unit EIP.
- Operators must use Port4 (not Port2/MGMT) for post-failover management.

### Alternatives rejected

| Alternative | Reason rejected |
|---|---|
| Admin on MGMT (default) | MGMT service has no failover coverage |
| Admin on Port2 (original plan) | Disproven — Port2 is data-plane, unreliable on standby |

---

## RFC-002 — CDK TypeScript over Terraform or raw CloudFormation

**Status:** Accepted  
**Date:** 2026-06-03

### Context

The infrastructure needs to be fully reproducible IaC. Three realistic options: AWS CDK (TypeScript), Terraform, or raw CloudFormation.

### Decision

Use **AWS CDK v2 with TypeScript**.

### Consequences

**Positive:**
- Dynamic AMI lookup (`ec2.MachineImage.lookup`) — no hardcoded AMI IDs that break across regions or FortiOS versions.
- Fine-grained assertion tests (`Template.fromStack`) validate resource properties without deploying.
- Strong typing catches misconfiguration at compile time.
- CDK synthesizes to CloudFormation — the deployment artifact is standard and inspectable.

**Negative:**
- CDK adds abstraction — the synthesized template is harder to read than hand-written CloudFormation.
- CDK bootstrap required per account/region.

### Alternatives rejected

| Alternative | Reason rejected |
|---|---|
| Terraform | HCL is declarative — harder to express dynamic logic (AMI lookup, UserData with cross-stack references). No built-in assertion test framework comparable to CDK. |
| Raw CloudFormation | Verbose. No compile-time type safety. AMI lookup requires a custom Lambda-backed resource. |

---

## RFC-003 — PAYG licensing over BYOL

**Status:** Accepted  
**Date:** 2026-06-03

### Context

FortiGate-VM on AWS supports two licensing models: PAYG (Marketplace, hourly software charge) and BYOL (bring your own license, requires a Fortinet license file).

### Decision

Use **PAYG** for this lab.

### Consequences

**Positive:**
- Zero license procurement friction — deploy immediately after accepting Marketplace terms.
- Hourly billing means no wasted spend on idle licenses.
- No license file to store, rotate, or accidentally commit to the public repo.

**Negative:**
- ~$1.02/hr software uplift per instance on `c6in.xlarge`. At 24/7 production scale, BYOL is significantly cheaper (~$340/mo flat vs ~$1,829/mo PAYG for a 2-instance cluster).
- PAYG is the right choice for a short-lived lab; wrong choice for production.

### Alternatives rejected

| Alternative | Reason rejected |
|---|---|
| BYOL | Requires Fortinet license (paid or eval). Adds procurement and secret management to a public portfolio lab. |

---

## RFC-004 — FGCP Active/Passive over GWLB Active/Active

**Status:** Accepted  
**Date:** 2026-06-03

### Context

AWS supports two FortiGate HA deployment patterns: FGCP Active/Passive (native FortiGate HA protocol) and Gateway Load Balancer (GWLB) Active/Active.

### Decision

Use **FGCP Active/Passive**.

### Consequences

**Positive:**
- FGCP is the deployment where the MGMT-failover behavior (RFC-001) manifests. The GWLB pattern routes at L3 and does not use FGCP callbacks — the lesson doesn't apply there.
- Simpler topology: no GWLB endpoint, no Gateway Load Balancer service.
- The failover sequence (EIP reassignment + route table update) is explicit and automatable.

**Negative:**
- A/P means one instance is idle (standby). GWLB A/A uses both instances actively.
- FGCP failover has a brief traffic interruption (~3–5s); GWLB has none.

### Alternatives rejected

| Alternative | Reason rejected |
|---|---|
| GWLB Active/Active | Correct for production scale, but obscures the MGMT-failover lesson. The repo exists to demonstrate RFC-001 — GWLB makes it irrelevant. |

---

## RFC-005 — Hexagonal validator over bash scripts

**Status:** Accepted  
**Date:** 2026-06-03

### Context

The failover validator needs to: query EC2 state, check EIP assignment, probe HTTPS reachability on Port2, and report a structured pass/fail. This can be implemented as bash (simple, no deps) or as a structured application.

### Decision

Implement the validator as a **hexagonal TypeScript application** with domain, ports, application, and adapter layers.

### Consequences

**Positive:**
- Domain logic (invariants) is pure TypeScript — zero AWS SDK imports, testable in-process with fakes.
- `FakeCloudQuery` and `FakeReachability` make every test deterministic and sub-millisecond.
- Coverage gate (≥90%) is enforced by jest.config — it's part of the CI contract, not a claim.
- `pollIntervalMs: 10` injected in tests means timeout scenarios run in milliseconds, not 120 seconds.
- The `ValidateFailoverUseCase` is open for extension (new invariants) without modifying existing tests.

**Negative:**
- More code than a bash script.
- Requires TypeScript toolchain (ts-node, jest, ts-jest).

### Alternatives rejected

| Alternative | Reason rejected |
|---|---|
| Bash script | Not testable. A bash `curl` loop with no assertions is not a validator — it's a status check. Adding real assertions in bash becomes fragile quickly. The point of this repo is engineering rigor. |
| Python with boto3 | Valid. TypeScript was chosen for consistency with the CDK infra layer. |

---

## RFC-006 — Dual cleanup: bash trap + WatchdogStack Lambda

**Status:** Accepted  
**Date:** 2026-06-03

### Context

A 30-minute lab that costs ~$1.34/run is only acceptable if the cleanup is reliable. A single cleanup mechanism has failure modes: the shell process can be killed, the terminal session can disconnect, or the script can hang.

### Decision

Implement **two independent cleanup mechanisms**:

1. `trap cleanup EXIT` in `deploy-and-test.sh` — runs `cdk destroy --all` whenever the shell exits, for any reason including errors and SIGTERM.
2. WatchdogStack — EventBridge `rate(30 minutes)` → Lambda → CodeBuild `cdk destroy --all`. Runs independently of the shell, in AWS, as long as the stacks exist.

### Consequences

**Positive:**
- Belt-and-suspenders: both mechanisms must fail for resources to be left running.
- The WatchdogStack survives a laptop lid close, a network drop, or a `kill -9`.
- CodeBuild has the same CDK permissions as the deployer — the destroy is reliable.

**Negative:**
- The WatchdogStack itself is a deployed resource. If cleanup fails completely, the WatchdogStack itself persists (but its destroy cost is negligible).
- Two destroy mechanisms can race if the lab finishes near the 30-minute mark — `cdk destroy` is idempotent, so this is safe.

### Alternatives rejected

| Alternative | Reason rejected |
|---|---|
| Bash trap only | Fragile — killed process, closed terminal, or hung command all bypass it. |
| Lambda only | Doesn't handle the common case of the script completing before 30 minutes. |

---

## RFC-007 — Heartbeat security group: allow all traffic between cluster members

**Status:** Accepted  
**Date:** 2026-06-09 (post-implementation — this was the project's root-cause fix)

### Context

`sg-ha` (Port3) was initially scoped to TCP/UDP 703 — the documented FGCP "HA port".
Failover never worked: `get system ha status` showed `number of member: 1` ("only member
in the cluster") on both units. The FGCP heartbeat is **not** TCP/UDP 703 (that is
session-sync); it is protocol-level packets (EtherType 0x8890/0x8891/0x8893, encapsulated
for unicast on AWS). The port-scoped rule silently dropped the heartbeat, so the two units
never formed a cluster and there was nothing to fail over to. Three runs were lost chasing
downstream IAM/EIP symptoms before SSH diagnostics revealed the 1-member cluster.

### Decision

Open `sg-ha` to **all traffic between cluster members** via a self-referencing rule. Both
Port3 ENIs share `sg-ha`, so the group references itself — open between members, closed to
everything else.

```typescript
this.sgHa = new ec2.SecurityGroup(this, 'SgHa', { vpc, allowAllOutbound: true });
this.sgHa.addIngressRule(this.sgHa, ec2.Port.allTraffic(),
  'FGCP heartbeat + session sync between cluster members');
```

### Consequences

**Positive:** the cluster forms; failover and EIP migration work with no other change.
The self-reference keeps the opening scoped to the two FortiGate Port3 ENIs only.

**Negative:** broader than a port list, but correctly bounded to cluster members. Trying to
enumerate every FGCP protocol/port is fragile and was the cause of the outage.

### Alternatives rejected

| Alternative | Reason rejected |
|---|---|
| Scope to TCP/UDP 703 | Drops the actual heartbeat — the root-cause bug |
| Scope to the VPC CIDR | Wider than self-reference and still must list protocols |

---

## RFC-008 — Layered diagnostics + pre-flight gate

**Status:** Accepted  
**Date:** 2026-06-09

### Context

The AWS control plane cannot see FGCP cluster state — the validator infers role from EIP
ownership, so it reported the same symptom (`no EIP holder`) for two different root causes.
Reasoning from AWS-API output alone cost multiple full deploy cycles.

### Decision

Capture three telemetry layers on every run, persisted to a log that survives auto-destroy:
EC2 serial console (boot), FortiOS runtime over SSH on Port4 (`get system ha status`, HA
history, config-sync checksums, `awsd` status), and a CloudTrail lookup of the EIP/route API
calls. Add a **pre-flight gate** that asserts `number of member: 2` before injecting any
fault — aborting in ~30 s instead of burning a full run on a non-cluster.

### Consequences

**Positive:** failures are diagnosable from one run; the pre-flight gate fails fast and cheap.
Diagnostics are zero added infra (console + SSH-via-bastion + free CloudTrail event lookup).

**Negative:** more script complexity; SSH diagnostics require the admin password set in
UserData and bastion→Port4 reachability.

### Alternatives rejected

| Alternative | Reason rejected |
|---|---|
| AWS-API telemetry only | Blind to FGCP cluster state — the original mistake |
| CloudWatch Logs from FortiOS | Needs an in-FortiOS agent + a log group (cost) for little gain on a one-shot lab |
