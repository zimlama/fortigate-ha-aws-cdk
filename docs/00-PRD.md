# Product Requirements Document — fortigate-ha-aws-cdk

> **Status:** Approved  
> **Owner:** Leonardo Mejia  
> **Created:** 2026-06-03

---

## Problem Statement

Deploying FortiGate Active/Passive HA on AWS requires understanding a non-obvious platform behavior: the MGMT interface is not covered by the FGCP failover callback. Engineers who configure admin access on MGMT lose management connectivity every time a failover occurs, without any error or warning from FortiOS. This creates a hidden operational risk in production environments.

There is no automated, reproducible way to verify that a FortiGate HA deployment correctly survives failover with management access intact. Manual testing is slow, expensive, and not repeatable in CI.

---

## Goals

1. Provide a fully automated, IaC-driven FortiGate HA deployment on AWS that implements the correct management configuration (Port2, not MGMT).
2. Provide an automated validator that proves the fix works — triggering a real failover and asserting management reachability on the new Active node.
3. Keep total lab cost under $2 per run via a 30-minute auto-destroy mechanism.
4. Serve as a credible, reviewable portfolio artifact demonstrating production-grade engineering practices.

## Non-Goals

- Active/Active HA with GWLB
- Multi-region deployment
- Production-ready hardening (e.g., VPC flow logs, WAF, centralized logging)
- BGP peering with Transit Gateway (documented as a natural next step)

---

## User Stories

### US-001 — Single-command deployment
**As a** network architect,  
**I want** to deploy a complete FortiGate HA cluster with a single command,  
**so that** I can reproduce the environment consistently without manual console steps.

**Acceptance criteria:**
- Given valid AWS credentials and an HA password, when I run `deploy-and-test.sh`, then both FortiGate instances reach `running` state with heartbeat established in under 10 minutes.
- The deployment requires no manual steps beyond accepting Marketplace terms (one-time prerequisite).

### US-002 — Automated failover validation
**As a** security engineer,  
**I want** the failover test to run automatically and report a clear pass/fail result,  
**so that** I can verify the management configuration without manual intervention.

**Acceptance criteria:**
- Given a healthy cluster, when the Active instance is terminated, then:
  - The EIP migrates to the new Active node.
  - Port2 management on the new Active node is reachable via HTTPS within 120 seconds.
  - The validator exits with code `0` and prints `FAILOVER PASSED ✅`.
- If either condition is not met within 120 seconds, the validator exits with code `1` and prints `FAILED ❌` with a specific reason.

### US-003 — Automatic resource cleanup
**As an** AWS account owner,  
**I want** all deployed resources to be destroyed automatically after the test,  
**so that** I am never charged for idle infrastructure.

**Acceptance criteria:**
- When `deploy-and-test.sh` exits (success, failure, or manual kill), the `trap cleanup EXIT` handler runs `cdk destroy --all`.
- A WatchdogStack Lambda fires at `rate(30 minutes)` as a backup, triggering a CodeBuild destroy even if the shell process is killed.
- After cleanup, `aws cloudformation list-stacks` returns no stacks matching `fortigate*`.

---

## Non-Functional Requirements

| Requirement | Target | Rationale |
|---|---|---|
| Time to deploy + test + destroy | < 30 min | Cost control |
| Cost per run | < $2 | `c6in.xlarge` × 2 PAYG for 30 min + data transfer |
| Failover detection | < 120 s | Realistic FGCP SLA in AWS |
| Validator test coverage | ≥ 90% (domain + application) | TDD differentiator |
| Hardcoded credentials | Zero | Public repository |

---

## Constraints

- All development via Claude Code CLI (OAuth session, no `ANTHROPIC_API_KEY`).
- AWS account: `test-admin` profile, `us-east-1`.
- FortiGate PAYG Marketplace terms must be accepted manually before first deploy (one-time).
- Instance type: `c6in.xlarge` — Fortinet's documented recommended default for FortiGate-VM, and the minimum PAYG Marketplace dimension.
