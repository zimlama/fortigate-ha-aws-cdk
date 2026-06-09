# FortiGate HA on AWS — Troubleshooting Runbook

> A field guide for detecting and isolating FortiGate Active-Passive (FGCP) HA
> failures on AWS. Built from real failures in this project — see
> [`lessons-learned.md`](./lessons-learned.md) for the post-mortems.

---

## 0. The golden rule

**Instrument before you theorize.** Most wasted time on this project came from
reasoning about a symptom one layer above the actual fault. Capture ground truth
from the FortiOS runtime *first*, then work outward.

---

## 1. The three telemetry layers

HA spans three planes. Each answers different questions and each has a blind spot.
Always know which layer a piece of evidence comes from.

| Layer | How to read it | Answers | Blind to |
|-------|----------------|---------|----------|
| **AWS control plane** | EC2/EIP API (validator, `aws` CLI) | Who holds the EIP, ENI/route table state, instance lifecycle | FGCP cluster membership and sync — **cannot** see if HA formed |
| **FortiOS boot** | `aws ec2 get-console-output` | Boot sequence, license activation, UserData config-apply errors | Anything after boot (runtime HA/SDN state) |
| **FortiOS runtime** | SSH CLI on **Port4 (HA-MGMT)** | Cluster membership, heartbeat, config sync, SDN connector | Nothing relevant — this is **ground truth** |

> The validator infers a node's role from **EIP ownership**. A node with no EIP
> always reports `role=PASSIVE`. Never use the validator to judge whether FGCP
> promoted a unit — only `get system ha status` can.

---

## 2. Pre-flight: prove the cluster is healthy BEFORE you break anything

A failover test on a cluster that never formed proves nothing and wastes a full
deploy cycle. **Gate the test** on cluster health. SSH each unit on Port4 and run:

```
get system ha status
```

Required state before terminating the Active:

- [ ] `HA Health Status: OK`
- [ ] `number of member: 2`  ← **the single most important check**
- [ ] Both serial numbers listed under the member section
- [ ] `diagnose sys ha checksum cluster` → checksums **match** across members (in sync)

If `number of member: 1`, **stop** — you have a heartbeat/cluster-formation
problem, not a failover problem. Go to §4.A. Do not terminate anything.

---

## 3. Failure decision tree

```
Failover test fails ("no EIP holder" / EIP did not migrate)
│
├─ SSH Port4 → get system ha status
│
├─ "number of member: 1" / "only member in the cluster"
│      → CLUSTER NEVER FORMED → §4.A (heartbeat / SG)
│
├─ "number of member: 2" but EIP still on terminated unit's ENI
│      → FAILOVER FIRED, EIP MOVE FAILED → §4.B (SDN connector / IAM)
│
├─ SSH Port4 times out (Port2 also times out)
│      → MGMT REACHABILITY → §4.C
│
└─ Instances never reach "running" / terminate immediately
       → MARKETPLACE / LICENSE → §4.D
```

---

## 4. Failure classes

### 4.A — Cluster never forms (heartbeat dropped)

**Signature**
```
get system ha status
  HA Health Status: OK
  Primary selected using:
     ... is selected as the primary because it's the only member in the cluster.
  number of member: 1
```

**Checks (in order)**
1. **Security group** — does `sg-ha` allow *all* traffic between the Port3 ENIs?
   FGCP heartbeat is not TCP/UDP 703; a port-scoped rule drops it. Verify a
   self-referencing allow-all rule exists (lesson #8).
   ```
   aws ec2 describe-security-groups --group-ids <sg-ha> \
     --query "SecurityGroups[0].IpPermissions"
   ```
2. **Unicast config** — both units must have `set unicast-hb enable` and the
   *peer's* Port3 IP:
   ```
   get system ha          # confirm unicast-hb + unicast-hb-peerip
   ```
3. **Peer IP correctness** — `unicast_hb: peerip=<X>` in `get system ha status`
   must equal the other unit's Port3 private IP. `myip=0.0.0.0` before peering is
   normal; it should populate once heartbeat flows.
4. **Heartbeat on the wire** — capture packets on the hbdev to confirm flow:
   ```
   diagnose sniffer packet port3 '' 4 10
   ```
   No packets from the peer ⇒ network/SG drop. Packets present but no cluster ⇒
   config mismatch (group-name, password, mode).
5. **Config divergence** — different `group-name`, HA `password`, or `mode`
   between units prevents joining even with connectivity.

**Most likely fix:** open `sg-ha` to all traffic between members (self-ref SG).

---

### 4.B — Failover fired but the EIP did not migrate

**Signature:** `number of member: 2` before the test; after terminating the
Active, the surviving unit is Primary but the cluster EIP is still associated to
the terminated unit's Port1 ENI.

**Checks**
1. **SDN connector health**
   ```
   diagnose test application awsd 1
   ```
   Look for: connector enabled, IAM credentials resolved (`use-metadata-iam`),
   last update success, and any API error text.
2. **Did awsd attempt the move?** Query CloudTrail for the FortiGate role's calls:
   ```
   aws cloudtrail lookup-events \
     --lookup-attributes AttributeKey=EventName,AttributeValue=AssociateAddress \
     --query "Events[].CloudTrailEvent" --output text | tail
   ```
   - No event ⇒ awsd never tried (connector/role/config problem).
   - Event with `errorCode` ⇒ IAM/permission or parameter problem — read the error.
3. **IAM policy** — the instance role needs `ec2:Describe*`, `ec2:AssociateAddress`,
   `ec2:DisassociateAddress`, `ec2:ReplaceRoute`, `ec2:Assign/UnassignPrivateIpAddresses`.
   `ec2:DisassociateAddress` is required here because the EIP is still bound to the
   terminated unit's (surviving, detached) ENI and must be released first.
4. **Route tables** — confirm the SDN connector lists *both* AZ route tables
   (`set route-table <rtA>,<rtB>`), and check they were updated:
   ```
   aws ec2 describe-route-tables --route-table-ids <rtA> <rtB>
   ```

---

### 4.C — Management unreachable

**Checks**
1. Use **Port4 (HA-MGMT)**, not Port2. Port2 is data-plane and may not answer
   management on a non-active unit (lesson #10).
2. SG: bastion → `sg-ha-mgmt` tcp/22 and tcp/443 must exist.
3. Auth: admin password must be set in UserData (default = instance-id and forces
   a change, blocking automation).
4. Interface allowaccess: `get system interface physical` → port4 `status: up`;
   config has `set allowaccess https ssh ping` on port4.

---

### 4.D — Instances never run

**Signature:** CloudFormation `CREATE_COMPLETE` but instances go
`pending → terminated`, with no CFN error.

**Checks**
1. **Marketplace subscription** accepted for the FortiGate PAYG AMI (lesson #6) —
   this fails *silently*; there is no CFN event.
2. **License activation** in console output — `VM license install succeeded`
   triggers a reboot; the box reboots ~twice on first boot. Budget boot wait
   accordingly (`HA_BOOT_WAIT`).
3. Console output for FortiCare `dns resolve error` loops ⇒ no egress to the
   internet (check IGW route + WAN/Port4 egress).

---

## 5. FortiOS command reference (run over Port4 SSH)

| Command | What it tells you |
|---------|-------------------|
| `get system ha status` | Cluster membership, primary selection reason, heartbeat peer/myip, uptime |
| `diagnose sys ha status` | Detailed HA daemon state |
| `diagnose sys ha checksum cluster` | Config-sync checksums per member — mismatch ⇒ out of sync |
| `diagnose sys ha history read` | HA event history incl. failover events and reasons |
| `diagnose sys ha dump-by vcluster` | vcluster composition |
| `diagnose sniffer packet port3 '' 4 10` | Live heartbeat packets on the hbdev |
| `diagnose hardware deviceinfo nic port3` | Port3 NIC counters (rx/tx/drops) |
| `diagnose test application awsd 1` | AWS SDN connector status (NOT `diagnose sys sdn-connector …` — parse error) |
| `diagnose debug application awsd -1` + `diagnose debug enable` | Verbose SDN connector: EIP/route operations as they happen |
| `get system interface physical` | Per-port mode/IP/up-down |
| `get router info routing-table all` | Effective routing table |

---

## 6. AWS-side command reference

| Command | What it tells you |
|---------|-------------------|
| `aws ec2 get-console-output --instance-id <id>` | FortiOS boot, license, config-apply errors |
| `aws ec2 describe-addresses` | EIP → ENI/instance associations (who holds the cluster EIP) |
| `aws ec2 describe-instances ... NetworkInterfaces` | ENI device indices: Port1=0, Port2=1, Port3=2, Port4=3 |
| `aws ec2 describe-security-groups --group-ids <sg-ha>` | Verify heartbeat SG rules |
| `aws ec2 describe-route-tables --route-table-ids <rtA> <rtB>` | Confirm failover route updates |
| `aws cloudtrail lookup-events --lookup-attributes EventName=AssociateAddress` | Did awsd attempt the EIP move? With what result? |

---

## 7. Failover timing (SLO)

Target: failover detection + EIP migration within **120 s** (`failoverTimeout`).
Capture two timestamps — when the Active was terminated, and when the surviving
unit first holds the EIP — and assert the delta. A pass with a slow delta is still
a regression worth flagging.

---

## 8. Telemetry roadmap — what to add next

**Implemented** (in `scripts/ha-test.sh`):

1. ✅ **Pre-flight HA health gate** (§2) — SSHes the Active on Port4 and asserts
   `number of member: 2` *before* terminating. Aborts with `exit 2` (nothing
   terminated) and points at §4.A. Catches the most common regression in ~30 s
   instead of a full ~30-min run.
2. ✅ **Richer FortiOS capture** — post-failover SSH dumps `get system ha status`,
   `diagnose sys ha history read`, `diagnose sys ha checksum cluster`,
   `diagnose test application awsd 1`, `diagnose hardware deviceinfo nic port3`,
   `get system interface physical`.
3. ✅ **CloudTrail query** — looks up `AssociateAddress` / `DisassociateAddress` /
   `ReplaceRoute` in the last 30 min and prints caller + `errorCode`, proving
   whether awsd attempted the move and what AWS returned. (Management events are on
   by default; note CloudTrail can lag ~15 min.)

**Backlog** (not yet implemented):

4. **VPC Flow Logs on the Port3 ENIs** — shows heartbeat `ACCEPT`/`REJECT`
   directly; a `REJECT` is a smoking gun for an SG drop. Small cost (a short-lived
   log group); enable only for a diagnostic run.
5. **Heartbeat packet capture** baked into diagnostics (`diagnose sniffer packet
   port3`) — definitive proof the heartbeat is or isn't on the wire.
6. **Failover timing assertion** (§7) in the validator.
