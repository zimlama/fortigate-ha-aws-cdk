# Architecture Decision Records — fortigate-ha-aws-cdk

> Six formal decisions made before writing any code.
> Format: Context → Decision → Consequences → Alternatives Rejected.

---

## RFC-001 — Admin access on Port2 (INTERNAL), not on MGMT

**Status:** Accepted  
**Date:** 2026-06-03

### Context

FortiGate HA uses the FGCP protocol to elect a new Active node. When failover occurs, FortiOS triggers a callback that calls the AWS EC2 API to:
1. Reassociate the Elastic IP from the old Active's Port1 to the new Active's Port1.
2. Update private route tables to point to the new Active's Port2.

The **MGMT interface is not part of this callback**. It has a fixed IP that stays with the original instance — meaning when the Passive takes over, the new Active has no management interface accessible from the operator's network.

This is not a bug. It is documented behavior: MGMT is designed for out-of-band management on a dedicated management network. The FGCP callback was designed for data-plane interfaces (Port1/Port2), not for MGMT.

### Decision

Configure `allowaccess https ssh` on **Port2 (INTERNAL)**, not on MGMT. Port2 is covered by the FGCP callback (route table update), so management connectivity follows the Active node automatically.

```
config system interface
  edit "port2"
    set allowaccess https ssh
    set alias "MGMT-Port2"
  next
end
```

### Consequences

**Positive:**
- Management access survives every failover automatically.
- The route table update (`ec2:ReplaceRoute`) is already part of the failover callback — no additional AWS permissions required.
- Cross-AZ failover works identically: Port2 is a private ENI, and the route table update works across AZs.

**Negative:**
- Port2 is on the private subnet (10.0.2.0/24 / 10.0.12.0/24), not directly internet-accessible. Access requires a VPN or bastion in the same VPC — which is the correct security posture anyway.
- Operators must know not to connect to the MGMT IP after failover.

### Alternatives rejected

| Alternative | Reason rejected |
|---|---|
| Use MGMT for admin (default) | Loses management on every failover — the exact problem this repo exists to solve |
| HA management interface (FortiOS feature) | Requires careful NIC ordering in AWS; complex and fragile vs. the Port2 approach |

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
