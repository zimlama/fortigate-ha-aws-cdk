# Product Requirements Document — fortigate-ha-aws-cdk

> **Status:** Approved  
> **Owner:** Leonardo Mejia  
> **Created:** 2026-06-03

---

## Problem Statement

There is no automated, reproducible way to verify that a FortiGate Active/Passive HA
deployment on AWS actually survives failover. Across two AZs there is no L2, so failover
is entirely API-driven (EIP reassociation + route-table updates via the FGCP/SDN
connector) — and several non-obvious platform behaviors silently break it: the HA
heartbeat is not plain TCP/UDP (a port-scoped security group drops it and the cluster
never forms), and the MGMT service does not follow the active unit. Manual testing of
all this is slow, expensive, and not repeatable in CI.

This project proves FGCP failover end-to-end (deploy → inject fault → validate EIP
migration → destroy) and ships a layered diagnostics harness so a failed run reveals
*why*. A key finding baked in: management must live on **Port4 (HA-MGMT)** — a dedicated
interface up on both units — because Port2 (data-plane) does not reliably answer
management on a standby unit.

---

## Goals

1. Provide a fully automated, IaC-driven FortiGate cross-AZ HA deployment on AWS with the correct heartbeat (self-referencing sg-ha) and management (Port4 HA-MGMT) configuration.
2. Provide an automated validator that proves failover works — triggering a real fault and asserting the cluster EIP migrated to the surviving node.
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
- Pre-flight: the cluster is confirmed as a healthy 2-member cluster before any fault is
  injected (else the test aborts without terminating anything).
- Given a healthy cluster, when the Active instance is terminated, then:
  - The cluster EIP migrates to the new Active node within 120 seconds (the pass/fail gate).
  - The validator exits with code `0` and prints `FAILOVER PASSED ✅`.
- Port2 HTTPS reachability is captured as informational telemetry (Port2 is data-plane;
  Port4 HA-MGMT is the management path) — not a pass/fail gate.
- If the EIP does not migrate within 120 seconds, the validator exits non-zero and prints
  `FAILED ❌` with a specific reason; layered diagnostics (console, SSH on Port4, CloudTrail)
  are captured regardless.

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
