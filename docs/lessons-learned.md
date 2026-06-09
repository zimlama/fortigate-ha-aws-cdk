# Lessons Learned

> Format: **Symptom → Tried → Worked → Why**
> Ordered by impact — the most costly mistakes first.

---

## ✅ Resolution status — failover PROVEN end-to-end (2026-06-09)

FGCP Active-Passive failover is validated end-to-end by `deploy-and-test.sh`:

```
[pre-flight] number of member: 2          → cluster formed (heartbeat SG fix)
Terminating Active node …                 → fault injected
[poll #1 | +0s] node …  role=ACTIVE  hasWanEip=true   → surviving unit took the EIP
EIP invariant: OK
PASSED ✅  Failover validation succeeded.
```

The cluster EIP migrated to the surviving unit on **poll #1 (< 10 s)**, then all
stacks auto-destroyed (cost guard intact).

**The one fix that unblocked everything:** the HA heartbeat security group
(`sg-ha`) was scoped to TCP/UDP 703 (session-sync), which silently dropped the
FGCP heartbeat — so the two units never formed a cluster and no failover could
occur. Opening `sg-ha` to **all traffic between cluster members** (self-referencing
rule) let the cluster form; failover and EIP migration then worked with no further
changes. See lesson **#8**. The earlier IAM theories were red herrings (lesson #9).

**How we found it:** SSH diagnostics on Port4 (`get system ha status`) showed
`number of member: 1` — ground truth that three blind, AWS-API-only runs never
surfaced. Instrumentation cracked it, not theory.

---

## 1. FortiGate MGMT interface does not fail over in AWS — use Port2 for admin access

**Symptom:** After failover, the new Active FortiGate is unreachable via HTTPS/SSH. The old Active IP is gone (instance terminated), and the new Active's MGMT interface has a different IP that was never made accessible.

**Tried:** Connecting to the MGMT IP of the new Active after failover. Timeout — the MGMT interface is not covered by the FGCP callback.

**Worked:** Configure `set allowaccess https ssh` on `port2` (INTERNAL). Port2 is a private ENI whose subnet route table is updated by the FGCP callback (`ec2:ReplaceRoute`). Management follows the Active node automatically.

**Why:** The FGCP failover callback in AWS performs exactly two API operations: `ec2:AssociateAddress` (EIP to new Port1) and `ec2:ReplaceRoute` (private route tables to new Port2). MGMT is not in scope for either operation. This is by design — FortiOS expects MGMT to be on a dedicated out-of-band network. In AWS, that assumption breaks.

---

## 2. `sourceDestCheck: false` is required on ALL ENIs, not just WAN

**Symptom:** Routing works for internet-bound traffic but fails for cross-ENI forwarding between subnets.

**Tried:** Setting `sourceDestCheck: false` only on Port1 (WAN) because that's the "router interface."

**Worked:** Setting `sourceDestCheck: false` on all 8 ENIs (Port1–Port4 × 2 instances).

**Why:** AWS's source/destination check validates that the packet's source or destination matches the ENI's IP. A FortiGate is a router — it legitimately forwards packets with third-party IPs on every interface, including the management (Port2) and heartbeat (Port3) ENIs. The check must be disabled on all of them.

---

## 3. AMI IDs change per region, per FortiOS version, and over time — use dynamic lookup

**Symptom:** CDK deploy fails with `InvalidAMIID.NotFound` when run in a different region or after a FortiOS version update.

**Tried:** Hardcoding the AMI ID found in the console at the time of writing.

**Worked:**
```typescript
ec2.MachineImage.lookup({
  name: 'FortiGate-VM64-AWSONDEMAND*',
  owners: ['679593333241'],
})
```

**Why:** Fortinet publishes new AMIs for each FortiOS minor release. The AMI ID is region-specific and changes without notice. Dynamic lookup resolves the latest AMI at synth time — the IaC never goes stale.

---

## 4. FGCP HA must use unicast in AWS — multicast is not available

**Symptom:** FortiGate HA heartbeat never establishes. Both nodes remain in ACTIVE state (split-brain).

**Tried:** Default FGCP configuration, which uses multicast for heartbeat discovery.

**Worked:**
```
config system ha
  set unicast-hb enable
  set unicast-hb-peerip <peer-port3-private-ip>
end
```

**Why:** AWS VPC does not support multicast. FGCP's default multicast heartbeat discovery silently fails — neither node sees the other, so both stay Active. Unicast mode requires the peer's explicit IP, which is why the CDK stack uses `eniP3b.attrPrimaryPrivateIpAddress` to inject the peer IP into the UserData at deploy time.

> ⚠️ Unicast config is **necessary but not sufficient**: the heartbeat SG must also
> permit the FGCP heartbeat. A security group scoped to TCP/UDP 703 silently drops it
> even with unicast configured — see lesson **#8**. (703 is session-sync, not the
> heartbeat itself.)

---

## 5. IAM role goes on the Instance Profile, not directly on the instance

**Symptom:** `cdk synth` succeeds but `cdk deploy` fails with `InvalidParameterValue: Invalid IAM Instance Profile`.

**Tried:** Passing the IAM Role ARN directly as `IamInstanceProfile` in the EC2 resource.

**Worked:** Creating an `AWS::IAM::InstanceProfile` wrapping the role and referencing the profile — which CDK's `ec2.Instance` handles automatically via `role:` prop.

**Why:** EC2 does not accept an IAM Role ARN directly. It requires an Instance Profile — a container resource that wraps the role and is what EC2 actually attaches. CDK abstracts this, but raw CloudFormation and some CDK escape hatches require it explicitly.

---

## 6. FortiGate PAYG Marketplace terms must be accepted before the first deploy — and it blocks silently

**Symptom:** `cdk deploy` completes successfully (CloudFormation stack reaches `CREATE_COMPLETE`) but EC2 instances never reach `running`. They stay in `pending` and then move to `terminated`.

**Tried:** Checking CloudFormation events — no errors. Checking EC2 console — instances terminate immediately.

**Worked:** Accepting the FortiGate PAYG subscription in the AWS Marketplace console for the account.

**Why:** AWS Marketplace PAYG AMIs silently refuse to launch if the account has not accepted the subscription terms. CloudFormation considers the `RunInstances` API call successful (the call itself does not fail), but the instance is immediately terminated by the Marketplace enforcement mechanism. There is no CloudFormation event or error — you have to know to check the Marketplace subscription status.

---

## 7. Cross-AZ HA adds a second route table update — both AZs must be covered

**Symptom:** After failover, traffic from AZ-b reaches the Passive (now Active) FortiGate via Port2-B correctly. But traffic from AZ-a still routes to the old Port2-A (terminated instance).

**Tried:** Updating only the route table of the AZ where the new Active lives.

**Worked:** Configuring the SDN connector with both private route table IDs:
```
config system sdn-connector
  edit "aws"
    set route-table <rtPrivate1aId>,<rtPrivate1bId>
  next
end
```

**Why:** In a 2-AZ design, each AZ has its own private route table. Both tables have a `0.0.0.0/0` route pointing to Port2 of the Active FortiGate. When failover occurs, the FGCP callback must update both route tables — otherwise the AZ where the old Active lived keeps routing to a terminated ENI. The SDN connector takes a comma-separated list of route table IDs.

---

## 8. The HA heartbeat security group must allow ALL traffic between cluster members — TCP/UDP 703 alone is NOT enough

**Symptom:** Both nodes boot healthy and `get system ha status` reports `HA Health Status: OK`, but each node says it is *"selected as the primary because it's the only member in the cluster"* and `number of member: 1`. The cluster never forms; the EIP never migrates on failover (there is no peer to fail over to). Looks like split-brain, but it is actually two independent 1-member clusters.

**Tried:** A tight `sg-ha` allowing only `TCP 703` and `UDP 703` (the documented FGCP "HA port") between the Port3 ENIs. Also chased downstream symptoms first — IAM permissions for `ec2:AssociateAddress` / `ec2:ReplaceRoute` / `ec2:DisassociateAddress` — all red herrings, because failover never reached the layer where those calls happen.

**Worked:** Allow ALL traffic *between cluster members* via a self-referencing rule — both Port3 ENIs share `sg-ha`, so the group references itself:
```typescript
this.sgHa = new ec2.SecurityGroup(this, 'SgHa', {
  vpc, description: 'sg-ha: FGCP heartbeat + session sync (intra-cluster)',
  allowAllOutbound: true,
});
this.sgHa.addIngressRule(this.sgHa, ec2.Port.allTraffic(),
  'FGCP heartbeat + session sync between cluster members');
```

**Why:** Port `703` carries FGCP **session sync** and the legacy multicast heartbeat — it is *not* the unicast heartbeat itself. The FGCP heartbeat is a set of protocol-level packets (EtherTypes `0x8890` / `0x8891` / `0x8893`) that, under unicast HA on AWS, are encapsulated and sent over the `hbdev`. A rule scoped to TCP/UDP 703 silently drops them, so the units never discover each other. Enumerating every protocol/port FGCP uses is fragile; the canonical FortiGate-on-AWS pattern is to permit *all* traffic strictly between the cluster members (self-referencing SG) and nothing else. This is the necessary complement to lesson #4: unicast config is required, but it is useless if the SG drops the heartbeat.

---

## 9. Diagnose at the right layer — the AWS control plane cannot see FGCP cluster state

**Symptom:** Three consecutive failover runs failed with the same AWS-side signal (`no EIP holder found`), which pointed (wrongly) at IAM/EIP-migration permissions. Hours were lost theorizing about the EIP move, when the real fault was one layer below: the cluster had never formed.

**Tried:** Reasoning from the validator output alone. The validator derives a node's "role" from **EIP ownership** (who holds the cluster-tagged EIP), so a node with no EIP always reports `role=PASSIVE` — it can never reveal whether FGCP actually promoted it. Serial console output (`ec2:GetConsoleOutput`) helped but only shows **boot**, not runtime HA state.

**Worked:** SSH from the in-VPC bastion to the surviving unit's **Port4 (HA-MGMT)** and run `get system ha status`. That single command revealed `number of member: 1` instantly — the source of truth that three blind runs never produced.

**Why:** There are three independent telemetry layers and each has a blind spot:
| Layer | Tool | Reveals | Blind to |
|-------|------|---------|----------|
| AWS control plane | validator (EC2/EIP API) | EIP ownership, ENI/route state | FGCP cluster membership, sync state |
| FortiOS boot | `ec2:GetConsoleOutput` | boot, license, config-apply errors | runtime HA/SDN state |
| FortiOS runtime | SSH CLI on Port4 | cluster membership, heartbeat, SDN connector | nothing relevant — this is ground truth |

The lesson: **instrument before theorizing.** Add the runtime probe first; do not infer a FortiOS-internal fault from AWS-API symptoms.

---

## 10. Admin password must be set in UserData; Port4 (HA-MGMT) is the only reliable SSH path

**Symptom:** Automated SSH diagnostics to the FortiGate failed or hung. Separately, SSH to Port2 timed out even though `get system interface physical` showed `port2 ... status: up`.

**Tried:** SSH as `admin` with the assumed password, over Port2.

**Worked:** (1) Set the admin password explicitly in UserData — `config system admin / edit "admin" / set password "<haPassword>"`. (2) Reach the unit over **Port4 HA-MGMT** (always-up, FGCP-independent), not Port2.

**Why:** On AWS, the FortiGate-VM default admin password is the **instance-id**, and first login **forces a password change** — which blocks any non-interactive SSH. Setting the password in UserData makes auth deterministic. As for the interface: Port2 is a **data-plane** interface; on a unit that is not the active member (or mid-promotion) it does not reliably answer management traffic, even when AWS reports the ENI as up. Port4 is the dedicated HA-management interface and is active on **both** units at all times — it is the correct path for diagnostics. (Tooling note: on Amazon Linux 2023 the bastion can do password SSH without `sshpass`/EPEL using OpenSSH 8.7+ `SSH_ASKPASS_REQUIRE=force` + `setsid -w`.)
