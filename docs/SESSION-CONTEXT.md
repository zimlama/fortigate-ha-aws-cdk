---
title: Session Context — FortiGate HA on AWS
date: 2026-06-09
author: Leonardo Mejía
---

# 📋 Session Context & Status

**Status:** ✅ **FAILOVER PROVEN END-TO-END**

FGCP Active-Passive failover across two AZs is validated automatically by
`scripts/deploy-and-test.sh`: deploy → confirm 2-member cluster → terminate the active →
the cluster EIP migrates to the survivor (poll #1, < 10 s) → all stacks auto-destroy.

```
[pre-flight] number of member: 2
==> Terminating Active node i-01c4…
[poll #1 | +0s] node i-09f4…  role=ACTIVE  hasWanEip=true   EIP invariant: OK
PASSED ✅  Failover validation succeeded.
==> PIPELINE COMPLETE — FAILOVER PASSED ✅   (then: all stacks destroyed)
```

---

## What changed this cycle (the debugging saga)

Failover failed on the first three runs. Root cause and fixes (full detail in
[`lessons-learned.md`](lessons-learned.md)):

1. **Root cause — heartbeat SG (lesson #8 / RFC-007).** `sg-ha` only allowed TCP/UDP 703
   (session-sync). The FGCP heartbeat is protocol-level (EtherType 0x8890/0x8891/0x8893),
   so it was dropped → the cluster never formed (`number of member: 1`) → no failover.
   Fix: `sg-ha` now allows **all traffic between cluster members** (self-referencing rule).

2. **Management path (lessons #9/#10 / RFC-001 revised).** Port2 is data-plane and
   unreliable on standby; management moved to **Port4 (HA-MGMT)**, up on both units.
   Admin password is now set in UserData (default = instance-id forces a change).

3. **Diagnostics + pre-flight (RFC-008).** Added a pre-flight gate (assert 2-member cluster
   before terminating), layered FortiOS/console/CloudTrail capture, and a persisted run log.
   This instrumentation is what surfaced the root cause that three blind runs missed.

---

## Current architecture (post-changes)

- **4 stacks:** Network → FortiGate → Bastion → Watchdog.
- **8 subnets / 8 ENIs:** Port1 WAN, Port2 data, Port3 HA heartbeat, Port4 HA-MGMT, ×2 AZ.
- **4 SGs:** sg-wan, sg-mgmt, **sg-ha (self-referencing all-traffic)**, sg-ha-mgmt.
- **EIPs:** 1 cluster VIP (tagged, fails over) on Port1-A + 2 per-unit mgmt EIPs on Port4.
- **IAM:** `ec2:Describe*` + Associate/Disassociate/ReplaceRoute + Assign/Unassign.
- **Bastion:** in-VPC SSM vantage for the validator + SSH diagnostics (Port4).

See [02-HLD.md](02-HLD.md), [03-LLD.md](03-LLD.md),
[06-cdk-preflight-design-checklist.md](06-cdk-preflight-design-checklist.md).

---

## How to run

```bash
cd repo
HA_PASSWORD='<secret>' ADMIN_CIDR=$(curl -s ifconfig.me)/32 \
  ./scripts/deploy-and-test.sh
```

Exit `0` = `FAILOVER PASSED ✅`. Run log: `/tmp/fgt-ha-run-<timestamp>.log` (survives the
auto-destroy). Two independent cost guards: the `trap cleanup EXIT` and the WatchdogStack.

---

## Next steps

- [x] Recreate HLD + LLD `.drawio` diagrams (4-port / 8-subnet / 4-stack).
- [ ] Export fresh PNGs from diagrams.net to refresh the embedded images.
- [ ] Optional telemetry backlog: VPC Flow Logs on Port3, heartbeat sniffer, failover-timing
      assertion (see runbook §8).
- [ ] Make the repo public (failover is now proven).

---

**Last updated:** 2026-06-09 · **Author:** Leonardo Mejía · **Status:** Failover proven ✅
