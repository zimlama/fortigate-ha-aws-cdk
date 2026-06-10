# ADR 0001 — FGCP heartbeat security group uses self-referencing ALL TRAFFIC rule

- **Status**: Accepted
- **Date**: 2026-06-09
- **Deciders**: Leonardo Mejia
- **Related**: `docs/04-fortinet-ha-reference-design.md`, `docs/lessons-learned.md` (#8–#10), PR #2

---

## Context

The first end-to-end deploy (`v1.0.0`) of this lab on a sandbox AWS account (us-east-1) failed at the failover step. The FortiGate cluster never formed (`number of member: 1`), so the FGCP failover callback could not re-associate the WAN EIP and the validator returned `no EIP holder found`.

The HA heartbeat security group (`sg-ha`) was configured with ingress TCP/UDP 703, which is the **session-sync** port — not the heartbeat port. The FortiGate Cluster Protocol (FGCP) heartbeat uses **protocol-level EtherType packets** (not TCP/UDP), so port-703-only rules silently drop them. The result is two units that each think they are the only cluster member and never negotiate.

This was confirmed by SSH-ing into Port4 (HA Management) and running `get system ha status`, which showed `number of member: 1` on both nodes.

## Decision

Replace the `sg-ha` ingress rule with a **self-referencing rule** that allows **all traffic** between any two instances that are members of `sg-ha` itself:

```typescript
new ec2.SecurityGroupRule(this, 'SgHaIngress', {
  securityGroup: sgHa,
  sourceSecurityGroup: sgHa,   // self-reference
  description: 'FGCP heartbeat + session sync between cluster members',
  allowAllTraffic: true,
});
```

This is the same pattern used by the Fortinet 8.0 reference design and by AWS's own HPC/cluster examples.

## Consequences

### Positive
- FGCP heartbeat packets (EtherType) are no longer dropped — cluster forms correctly on first boot.
- Session-sync traffic (TCP 703) is also permitted — the same rule covers both.
- No change to instances, route tables, or FortiOS config — the fix is purely at the network boundary.
- The pattern is **idempotent** and works for any cluster size (2-node, 4-node, etc.) without per-port enumeration.

### Negative
- `sg-ha` is now slightly more permissive than strictly needed — but only between members of the same SG. The blast radius is bounded to "anything attached to `sg-ha`", which by design is only the FortiGate cluster members.
- A future engineer reading the rule might mistake it for a typo. We mitigate with a clear `description` field ("FGCP heartbeat + session sync between cluster members") and this ADR.

### Neutral
- The pre-flight `ha-test.sh` check (`number of member: 2`) is now load-bearing — if the SG regresses, the test fails before any AWS API calls.

## Alternatives considered

1. **Allow all traffic `0.0.0.0/0` on `sg-ha`** — rejected. We don't need (or want) internet-reachable heartbeat.
2. **Per-port enumeration (TCP 703 + UDP 703 + EtherType 0x8890)** — rejected. FGCP uses multiple EtherType values depending on platform/version, and per-port rules rot. The self-referencing pattern is the Fortinet-recommended approach and is version-agnostic.
3. **Use VPC endpoint policies for `ec2:AssociateAddress`** — considered, but the failure mode we hit had nothing to do with the API path. The IAM permissions fix was a separate, additive change.

## References

- FortiGate Public Cloud 8.0 Administration Guide — *Deploying FortiGate-VM Active-Passive HA on AWS between multiple zones*
- `docs/04-fortinet-ha-reference-design.md` — full gap analysis
- `docs/lessons-learned.md` lessons #8, #9, #10 — symptom → tried → worked → why
- PR #2 — `feat(ha): integrate heartbeat fix from feature/heartbeat-fix via narrative commit`
