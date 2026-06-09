# CDK Pre-Flight & Design-Invariants Checklist

> A design contract for FortiGate FGCP Active-Passive HA on AWS as built by this
> CDK. Each invariant is something that **must hold** for HA to work. If you change
> the architecture, walk this list: confirm each invariant still holds, or you will
> reintroduce a failure we already paid for.
>
> Companion docs: [`04-fortinet-ha-reference-design.md`](./04-fortinet-ha-reference-design.md)
> (the target design), [`05-troubleshooting-ha-runbook.md`](./05-troubleshooting-ha-runbook.md)
> (how to detect a violation at runtime), [`lessons-learned.md`](./lessons-learned.md)
> (the post-mortems).

Legend: **Enforced in** = where the CDK guarantees it · **Verify** = how to check ·
**If broken** = the runtime signature + runbook section.

---

## A. VPC & subnets

| # | Invariant | Enforced in | Verify | If broken |
|---|-----------|-------------|--------|-----------|
| A1 | 8 subnets: WAN/Private/HA/MGMT × 2 AZs, non-overlapping CIDRs | `network-stack.ts` + `config/defaults.ts` | `cdk synth` shows 8 `AWS::EC2::Subnet` | wrong AZ placement breaks cross-AZ HA |
| A2 | Two AZs (`maxAzs: 2`), one unit per AZ | `network-stack.ts` VPC | subnets split `…a` / `…b` | single-AZ defeats the HA design goal |
| A3 | No NAT gateways; egress via IGW on public + mgmt subnets only | `network-stack.ts` (`natGateways: 0`) | route tables | HA/Private subnets must NOT reach internet directly |

---

## B. ENIs & port mapping (the most error-prone area)

| # | Invariant | Enforced in | Verify | If broken |
|---|-----------|-------------|--------|-----------|
| B1 | Fixed port roles: **Port1=WAN, Port2=Private/data, Port3=HA heartbeat, Port4=HA-MGMT** | `fortigate-stack.ts` ENI subnet assignment | ENI descriptions | mislabeled ports break heartbeat / mgmt |
| B2 | Device indices: Port1=0, Port2=1, Port3=2, Port4=3 | `cfnFgt*.networkInterfaces` order | `describe-instances … NetworkInterfaces[].Attachment.DeviceIndex` | diagnostics read the wrong IP (ha-test resolves Port4 by `DeviceIndex==3`) |
| B3 | **All 4 ENIs attached AT LAUNCH** (not post-boot) | `cfnFgt*.networkInterfaces` + `addPropertyDeletionOverride` | single `RunInstances` with 4 NICs | UserData runs before ports exist → HA + SDN silently broken |
| B4 | `sourceDestCheck: false` on **every** ENI | each `CfnNetworkInterface` | `describe-network-interfaces … SourceDestCheck` | cross-ENI forwarding drops (lesson #2) |

---

## C. Security groups

| # | Invariant | Enforced in | Verify | If broken |
|---|-----------|-------------|--------|-----------|
| C1 | **`sg-ha` allows ALL traffic BETWEEN cluster members** (self-referencing rule) | `network-stack.ts` `sgHa.addIngressRule(this.sgHa, allTraffic())` | `describe-security-groups` shows self-ref allow-all | **cluster never forms** → `number of member: 1` → runbook §4.A (lesson #8) |
| C2 | `sg-ha-mgmt` (Port4) allows admin 22/443 + ICMP, outbound 443 to EC2 API | `network-stack.ts` `sgHaMgmt` | ingress/egress rules | no EC2 API egress → SDN connector can't move EIP; no SSH diag |
| C3 | `sg-wan` (Port1) allows 443/IKE/ICMP from internet | `network-stack.ts` `sgWan` | ingress rules | no inbound service / health probes |
| C4 | `sg-mgmt` (Port2) allows admin 22/443 from `adminCidr` only | `network-stack.ts` `sgMgmt` | ingress rules | over-exposure, or no admin access |
| C5 | Bastion → Port4 (22) and Port2 (22/443) ingress exist | `bastion-stack.ts` `BastionToPort4Ssh` / `BastionToPort2*` | ingress on sgHaMgmt/sgMgmt | diagnostics/validator can't reach the FortiGate |

> **Heartbeat rule of thumb:** FGCP heartbeat is NOT TCP/UDP 703 — never scope
> `sg-ha` to specific ports. Allow all *between members* (self-ref) and nothing else.

---

## D. Routing

| # | Invariant | Enforced in | Verify | If broken |
|---|-----------|-------------|--------|-----------|
| D1 | Public + MGMT subnets have a `0.0.0.0/0 → IGW` route | `network-stack.ts` `addRoute` | route tables | no internet → license/PAYG + EC2 API fail |
| D2 | Private route tables (both AZs) reused and passed to SDN connector | `network-stack.ts` `rtPrivate1a/1b` → `fortigate-stack.ts` `set route-table` | UserData `route-table <a>,<b>` | post-failover routing keeps pointing at terminated ENI (lesson #7) |
| D3 | One route-table association per subnet (no duplicates) | `ec2.Subnet` auto-association reused | `cdk deploy` stabilizes | CloudFormation `NotStabilized` |

---

## E. IAM (FortiGate instance role)

| # | Invariant | Enforced in | Verify | If broken |
|---|-----------|-------------|--------|-----------|
| E1 | Role has `ec2:Describe*`, `AssociateAddress`, `DisassociateAddress`, `ReplaceRoute`, `Assign/UnassignPrivateIpAddresses` | `fortigate-stack.ts` `FgtRole` | inline policy | EIP/route move fails — runbook §4.B |
| E2 | `DisassociateAddress` present | `fortigate-stack.ts` | inline policy | EIP stuck on terminated unit's ENI (it must be released first) |
| E3 | Role attached via Instance Profile, `use-metadata-iam enable` in SDN connector | CDK `role:` prop + UserData | `diagnose test application awsd 1` | connector has no credentials |

> E1/E2 only matter **after** the cluster forms and failover fires. If `number of
> member: 1`, fix C1 first — IAM is a red herring until then (lesson #9).

---

## F. UserData / FortiOS config

| # | Invariant | Enforced in | Verify | If broken |
|---|-----------|-------------|--------|-----------|
| F1 | Admin password set explicitly (`config system admin / set password`) | `fortigate-stack.ts` UserData | SSH as `admin`/HA_PASSWORD | default = instance-id + forced change → no automated SSH (lesson #10) |
| F2 | HA mode a-p, matching `group-name` + `password` on both units | UserData (both) | `get system ha status` | mismatched units won't join |
| F3 | **Unicast HA**: `set unicast-hb enable` + peer's Port3 IP | UserData `unicast-hb-peerip` | `get system ha status` peerip | AWS has no multicast → no heartbeat (lesson #4) |
| F4 | Distinct priorities (active>passive) + `override enable` | `config/defaults.ts` `haPriorities` | `get system ha status` priority | deterministic primary selection lost |
| F5 | `ha-mgmt-status enable` + `ha-mgmt-interfaces` on Port4 w/ gateway | UserData | reachable Port4 on both units | mgmt unreachable on standby |
| F6 | `allowaccess https ssh` on Port2 and Port4 | UserData `config system interface` | `get system interface physical` | diagnostics/admin blocked |
| F7 | SDN connector: `type aws`, `ha-status enable`, both route tables | UserData `config system sdn-connector` | `diagnose test application awsd 1` | no failover callback |

---

## G. EIPs

| # | Invariant | Enforced in | Verify | If broken |
|---|-----------|-------------|--------|-----------|
| G1 | Exactly ONE cluster EIP, tagged `FortigateHACluster`, on Port1-Active | `fortigate-stack.ts` `EipActive` | `describe-addresses` tags | validator finds active by this tag — extra tagged EIPs break detection |
| G2 | Per-unit MGMT EIPs on Port4 are **NOT** tagged with the cluster tag | `fortigate-stack.ts` `EipMgmtA/B` | tags `active-mgmt`/`passive-mgmt` | mis-tag → validator picks wrong "active" |
| G3 | MGMT EIPs do not fail over (independent EC2 API egress per unit) | design | each unit reaches EC2 API independently | SDN connector loses egress on standby |

---

## H. Timing, license & lifecycle

| # | Invariant | Enforced in | Verify | If broken |
|---|-----------|-------------|--------|-----------|
| H1 | Marketplace PAYG subscription accepted for the account | manual (one-time) | Marketplace console | instances `pending → terminated`, no CFN error (lesson #6) |
| H2 | Boot wait covers ~2 license reboots before testing | `deploy-and-test.sh` `HA_BOOT_WAIT` | console output reboots | testing before HA is up = no failover |
| H3 | AMI via dynamic lookup, not hardcoded | `fortigate-stack.ts` `MachineImage.lookup` | `cdk synth` | `InvalidAMIID.NotFound` (lesson #3) |
| H4 | Watchdog auto-destroy + script cleanup trap (cost guard) | `watchdog-stack.ts` + `deploy-and-test.sh` trap | stacks gone after run | runaway cost (the 16-hour incident) |

---

## I. Diagnostics prerequisites (so a failed run is analyzable)

| # | Invariant | Enforced in | Verify | If broken |
|---|-----------|-------------|--------|-----------|
| I1 | In-VPC bastion (SSM-managed) reachable Port4/Port2 | `bastion-stack.ts` | `ha-test.sh` SSH works | no in-VPC vantage → can't read FGCP state |
| I2 | Outputs expose Port2 + Port4 IPs of both units | `fortigate-stack.ts` `CfnOutput` | `/tmp/fgt-outputs.json` | pre-flight/diagnostics can't resolve targets |
| I3 | Full run log persisted outside AWS (survives destroy) | `deploy-and-test.sh` `tee` | `/tmp/fgt-ha-run-*.log` | evidence lost when stacks are torn down |
| I4 | Pre-flight gate asserts 2-member cluster before terminate | `ha-test.sh` `[pre-flight]` | exit 2 + §4.A pointer | wasted ~30-min cycles on a non-cluster |

---

## How to use this when changing the design

1. **Identify the blast radius** — which sections above touch the construct you are
   editing (e.g. changing the heartbeat to a shared port touches C1, B1, F3).
2. **Re-confirm each invariant** in those sections after the change.
3. **Run the pre-flight gate** (`ha-test.sh` aborts at §I4 if the cluster didn't
   form) — it catches the most common regression (C1) in ~30 s, before any
   termination or cost.
4. **If a runtime symptom appears**, jump from the "If broken" column straight to
   the matching runbook section — the mapping is intentional.
