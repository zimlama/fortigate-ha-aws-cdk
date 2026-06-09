# 04 — Fortinet A-P HA on AWS: Official Reference Design & Gap Analysis

> **Source of truth**: [FortiGate-VM Active-Passive HA on AWS between multiple zones — FortiGate Public Cloud 8.0.0 Administration Guide](https://docs.fortinet.com/document/fortigate-public-cloud/8.0.0/aws-administration-guide/229470/deploying-fortigate-vm-active-passive-ha-aws-between-multiple-zones)
>
> Captured 2026-06-06 after the first real `deploy-and-test.sh` run, whose failover step FAILED. This document records the **official multi-AZ reference design** and the **gap** between it and our current implementation, so the fix is grounded in Fortinet's design — not guesswork.

---

## 1. Why this document exists

The first end-to-end deploy on AWS (account `064625181580`, us-east-1) succeeded structurally — all three stacks reached `CREATE_COMPLETE` and auto-destroy cleaned up with zero orphaned resources. But the failover validator **FAILED** after terminating the active node:

```
FAILED ❌  Failover validation failed.
  - no EIP holder found
  - no active node found
  - validation timed out after 120000ms
```

The passive never promoted itself / never re-associated the EIP. Comparing our implementation against the official 8.0 reference revealed a **structural gap**, not a config typo.

---

## 2. Official reference design (Fortinet 8.0, multi-AZ)

### 2.1 Interface layout — FOUR ports per FortiGate

| Port  | Role           | Subnet (example)      | Public? | EIP        |
|-------|----------------|-----------------------|---------|------------|
| port1 | WAN            | public  (10.0.0.0/24) | yes     | **EIP**    |
| port2 | Internal       | private (10.0.1.0/24) | no      | —          |
| port3 | HA heartbeat   | private (10.0.2.0/24) | no      | —          |
| port4 | **HA Management** | public (10.0.3.0/24) | yes  | **EIP**    |

Each unit needs **4 ENIs** (4 vCPUs minimum). FortiGate B mirrors the layout in the second AZ (10.0.10/11/12/13.0/24).

### 2.2 The key mechanism — dedicated HA Management interface (port4)

This is the part our design is missing entirely. Each FortiGate reaches the **public AWS EC2 API independently** through **port4 (HA Management) with its own EIP**. This egress path is what lets the newly-promoted unit call `ec2:AssociateAddress` and `ec2:ReplaceRoute` on failover.

> Fortinet design choice: failover does **NOT** use NAT or a VPC endpoint — it relies on direct per-unit management-port EIP egress. The HA-mgmt interface does **not** itself failover; each unit keeps its own.

### 2.3 `config system ha` — exact CLI

**FortiGate A (primary, priority 255):**
```
config system ha
    set group-name "test"
    set mode a-p
    set hbdev "port3" 50
    set session-pickup enable
    set ha-mgmt-status enable
    config ha-mgmt-interfaces
        edit 1
            set interface "port4"
            set gateway 10.0.3.1
        next
    end
    set override disable
    set priority 255
    set unicast-hb enable
    set unicast-hb-peerip 10.0.12.11
end
```

**FortiGate B (secondary, priority 1):** identical, except `gateway 10.0.13.1`, `priority 1`, and `unicast-hb-peerip 10.0.2.11`.

The two new bits vs our config: **`set ha-mgmt-status enable`** and the **`config ha-mgmt-interfaces`** block binding port4 as the management egress.

### 2.4 SDN connector

The 8.0 multi-AZ guide does **not** require an explicit `config system sdn-connector` block. EIP/route failover is driven by the built-in **`awsd`** daemon on HA state transition, authenticated via the instance IAM role. On promotion, the logs show:

```
awsd doing ha failover for vdom root
awsd associate elastic ip allocation eipalloc-... to 10.0.10.11 of eni eni-...
awsd update route table rtb-..., replace route of dst 0.0.0.0/0 to eni-...
```

No manual failover scripts. HA state detection on port3 triggers `awsd` to reassign EIPs and update routes automatically.

### 2.5 IAM permissions (reference)

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Action": [
      "ec2:Describe*",
      "ec2:AssociateAddress",
      "ec2:AssignPrivateIpAddresses",
      "ec2:UnassignPrivateIpAddresses",
      "ec2:ReplaceRoute"
    ],
    "Resource": "*",
    "Effect": "Allow"
  }]
}
```

---

## 3. Gap analysis — reference vs our implementation

| # | Concern | Fortinet 8.0 reference | Our implementation (`infra/lib/fortigate-stack.ts`) | Impact |
|---|---------|------------------------|------------------------------------------------------|--------|
| 1 | **HA management egress** | Dedicated **port4** HA-mgmt with **EIP on EACH unit** | No port4. Only 3 ports. Only the active has an EIP (on port1) | **BLOCKER** — passive cannot reach EC2 API to perform failover |
| 2 | `ha-mgmt-status` / `ha-mgmt-interfaces` | Enabled, bound to port4 | Absent | Failover egress not isolated; awsd has no mgmt path |
| 3 | `awsd` API auth | Instance IAM role (direct) | IAM role present, but no egress to use it | Calls would have no network path |
| 4 | IAM actions | adds `AssignPrivateIpAddresses` / `UnassignPrivateIpAddresses` | missing those two | Secondary-IP failover path unavailable |
| 5 | SDN connector | not required (awsd-driven) | partial block (`type aws` + `route-table`), missing `use-metadata-iam` | Likely inert; not the real fix |
| 6 | Instance ENIs | 4 ENIs needed | 3 ENIs | `c6in.xlarge` supports **exactly 4** ENIs / 4 vCPUs — adding port4 fits with **zero headroom** |
| 7 | SSH key pair | n/a | no `keyName` on instances | Can't SSH to FortiOS for live `get sys ha status` debugging |

---

## 4. What the fix entails (per reference)

1. **NetworkStack** — add two public HA-mgmt subnets (one per AZ) with IGW routes.
2. **FortiGateStack** — add `port4` ENI per unit (deviceIndex 3), allocate an **EIP per unit on port4**, and update UserData with `ha-mgmt-status enable` + `config ha-mgmt-interfaces`.
3. **IAM** — add `ec2:AssignPrivateIpAddresses` and `ec2:UnassignPrivateIpAddresses`.
4. **Instance type** — `c6in.xlarge` fits 4 ENIs exactly; no change needed, but no room for a 5th interface.
5. **(Debug aid)** — optionally add a `keyName` so FortiOS is reachable via SSH for `get sys ha status` / `diagnose debug application awsd -1`.

> **Cost note** (constraint: "lo más barato posible"): the reference adds **one extra EIP per unit** (free while associated to a running instance) — no NAT GW, no VPC endpoint. This is the cheapest correct option *and* matches the official design, which makes it the most defensible choice for a portfolio piece.

---

## 5. Resolution — aligned with the Fortinet 8.0 reference (implemented & proven)

The project's *original* thesis was: *"FortiGate's MGMT interface does NOT failover;
management must live on Port2 (INTERNAL), which IS covered by the failover callback."*

The Fortinet 8.0 reference takes a **different** stance: management lives on a **dedicated
port4 that does NOT failover** — each unit keeps its own HA-mgmt EIP precisely so it can
always reach the EC2 API, even as passive. The original 3-port design collapsed management
onto port2 and gave only the active an EIP.

**Decision (2026-06-09): aligned fully with the 8.0 reference — implemented and proven.**
The CDK now ships the 4-port layout (per-unit HA-mgmt EIP on port4, `ha-mgmt-status enable`,
`ha-mgmt-interfaces` bound to port4). Combined with the heartbeat-SG fix (lesson #8),
FGCP failover and EIP migration are validated end-to-end. The original Port2-management
thesis was disproven and retired — Port2 is data-plane and unreliable on standby; Port4 is
the management path. See [`lessons-learned.md`](lessons-learned.md) #8/#9/#10 and
[`01-RFC.md`](01-RFC.md) RFC-001 (revised) / RFC-007.

---

## Sources

- [FortiGate-VM A-P HA on AWS between multiple zones (8.0.0)](https://docs.fortinet.com/document/fortigate-public-cloud/8.0.0/aws-administration-guide/229470/deploying-fortigate-vm-active-passive-ha-aws-between-multiple-zones) — primary reference
- [Configuring an AWS SDN connector using IAM roles (7.6.0)](https://docs.fortinet.com/document/fortigate-public-cloud/7.6.0/aws-administration-guide/619567/configuring-an-aws-sdn-connector-using-iam-roles)
- [fortinet/aws-cloudformation-templates — HA/6.2/DualAZ](https://github.com/fortinet/aws-cloudformation-templates/tree/master/HA/6.2/DualAZ)
