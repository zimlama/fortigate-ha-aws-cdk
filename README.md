# fortigate-ha-aws-cdk

**Proven cross-AZ FortiGate FGCP failover on AWS — deploy, inject a fault, validate, destroy.**
One command stands up a 2-AZ Active-Passive FortiGate cluster, terminates the
active node, and automatically proves the Elastic IP migrated to the survivor —
then tears everything down. Backed by a layered diagnostics harness so a failed
run tells you *why*, not just *that* it failed.

[![Validator](https://github.com/zimlama/fortigate-ha-aws-cdk/actions/workflows/ci.yml/badge.svg?job=validator)](https://github.com/zimlama/fortigate-ha-aws-cdk/actions/workflows/ci.yml)
[![Infra](https://github.com/zimlama/fortigate-ha-aws-cdk/actions/workflows/ci.yml/badge.svg?job=infra)](https://github.com/zimlama/fortigate-ha-aws-cdk/actions/workflows/ci.yml)
![Coverage](https://img.shields.io/badge/coverage-%E2%89%A590%25-brightgreen)
![CDK](https://img.shields.io/badge/CDK-v2%20TypeScript-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Proven

```
[pre-flight] number of member: 2                       → 2-member cluster formed
==> Terminating Active node i-01c4…                    → fault injected
[poll #1 | +0s] node i-09f4…  role=ACTIVE  hasWanEip=true   → survivor took the EIP (<10 s)
EIP invariant: OK
PASSED ✅  Failover validation succeeded.
==> PIPELINE COMPLETE — FAILOVER PASSED ✅
==> [cleanup] all stacks destroyed
```

Across two Availability Zones there is no L2, so failover is 100% API-driven: the
FGCP callback calls `ec2:AssociateAddress` (move the cluster EIP) and
`ec2:ReplaceRoute` (repoint both private route tables). The validator confirms the
EIP landed on the surviving unit.

---

## What it took to get there (the honest version)

Failover did not work on the first three runs — and the failure was never where it
looked. The full post-mortems are in [`docs/lessons-learned.md`](docs/lessons-learned.md);
two matter most:

- **Root cause — the heartbeat security group.** `sg-ha` was scoped to TCP/UDP 703
  (session-sync). The FGCP heartbeat is *not* 703 — it's protocol-level packets
  (EtherType 0x8890/0x8891/0x8893, encapsulated for unicast). The narrow rule
  silently dropped it, so the two units never formed a cluster (`number of member: 1`)
  and no failover could occur. Fix: allow **all traffic between cluster members**
  via a self-referencing rule. (lesson #8)

- **Management does NOT fail over — and Port2 is the wrong place for it.** Port2 is
  a data-plane interface; it does not reliably answer management on a standby unit.
  **Port4 (HA-MGMT)** is the dedicated management interface, active on both units at
  all times — the correct path for admin and diagnostics. (lessons #9/#10)

The lesson under the lessons: **instrument before you theorize.** SSH `get system ha
status` on Port4 revealed the 1-member cluster in seconds — ground truth that three
AWS-API-only runs never surfaced.

---

## Architecture

![FortiGate HA 2-AZ Architecture](docs/diagrams/02-HLD-fortigate-ha.png)

2 AZs, one FortiGate per AZ, four interfaces each:

| Port | Role | Subnet | Notes |
|------|------|--------|-------|
| Port1 | WAN | public | carries the cluster EIP (fails over) |
| Port2 | data / internal | private | route-table target; data-plane |
| Port3 | HA heartbeat | ha | FGCP unicast heartbeat + session sync |
| Port4 | HA-MGMT | mgmt | dedicated mgmt, per-unit EIP, always up |

> Source: [`docs/diagrams/02-HLD-fortigate-ha.drawio`](docs/diagrams/02-HLD-fortigate-ha.drawio) — open in [diagrams.net](https://app.diagrams.net) to edit.

---

## Diagnostics harness

A failed failover run is only useful if it's analyzable. The harness captures three
telemetry layers, all persisted to a run log that survives the auto-destroy:

- **Pre-flight gate** — asserts `number of member: 2` *before* terminating anything;
  aborts in ~30 s on a non-cluster instead of burning a full run.
- **AWS control plane** — the validator polls EIP ownership / ENI / route state.
- **FortiOS boot** — EC2 serial console output (license, config-apply).
- **FortiOS runtime** — SSH on Port4: `get system ha status`, HA history, config-sync
  checksums, SDN connector (`awsd`) status, heartbeat NIC counters.
- **CloudTrail** — did `awsd` actually call `AssociateAddress` / `ReplaceRoute`, and
  what did AWS return? (free management-event lookup — no trail created)

Full guides: [troubleshooting runbook](docs/05-troubleshooting-ha-runbook.md) ·
[CDK design-invariants checklist](docs/06-cdk-preflight-design-checklist.md).

---

## What's inside

```
fortigate-ha-aws-cdk/
├── docs/
│   ├── 00-PRD.md                          Product requirements
│   ├── 01-RFC.md                          Architecture decisions
│   ├── 02-HLD.md                          High level design + failover sequence
│   ├── 03-LLD.md                          CDK construct details, SG rules, IAM
│   ├── 03-DEPLOYMENT-GUIDE.md             Run/operate the pipeline
│   ├── 04-fortinet-ha-reference-design.md Fortinet cross-AZ reference
│   ├── 05-troubleshooting-ha-runbook.md   Detect & isolate HA failures
│   ├── 06-cdk-preflight-design-checklist.md  Design invariants (change-the-design guide)
│   ├── lessons-learned.md                 Post-mortems (incl. the root cause)
│   ├── cost-analysis.md                   FortiGate PAYG vs AWS-native secure edge
│   └── diagrams/                          draw.io source (editable)
├── infra/                      CDK TypeScript — 4 stacks
│   ├── lib/network-stack.ts    VPC, 8 subnets, IGW, 4 SGs (sg-ha self-referencing)
│   ├── lib/fortigate-stack.ts  2× c6in.xlarge, 8 ENIs, EIPs, IAM role, UserData
│   ├── lib/bastion-stack.ts    In-VPC SSM vantage for validator + SSH diagnostics
│   ├── lib/watchdog-stack.ts   EventBridge → Lambda → CodeBuild auto-destroy
│   └── test/                   CDK fine-grained assertion tests
├── validator/                  Hexagonal failover validator
│   ├── src/domain/             Pure domain — FailoverOutcome, HAState, invariants
│   ├── src/application/        ValidateFailoverUseCase (depends on ports, not AWS)
│   ├── src/adapters/           EC2 + HTTPS adapters (boundary I/O)
│   └── test/                   ≥90% coverage, zero real AWS calls
└── scripts/
    ├── deploy-and-test.sh      Full pipeline + auto-destroy trap + run log
    └── ha-test.sh              Pre-flight gate → failover → layered diagnostics
```

---

## Engineering approach

This isn't a collection of scripts. The design follows a production process:

| Artifact | What it captures |
|---|---|
| **PRD / RFC** | Requirements and formal architecture decisions |
| **HLD / LLD** | 2-AZ topology, failover sequence, CDK construct detail |
| **Runbook + checklist** | How to detect a failure, and the invariants that must hold if you change the design |
| **TDD + hexagonal** | Domain is pure TypeScript (zero AWS SDK imports); adapters are the only boundary |

The validator's domain never imports `@aws-sdk`. `FakeCloudQuery` / `FakeReachability`
make every test deterministic and instant — `pollIntervalMs: 10` runs the timeout
scenario in milliseconds, not 120 seconds.

---

## Cost

| Scenario | Monthly | Per lab run (~30 min) |
|---|---|---|
| FortiGate HA PAYG (`c6in.xlarge` × 2) | ~$1,829 flat | ~$1.34 |
| AWS-native (Network Firewall 2-AZ + S2S VPN + TGW) | ~$613 + $73/site | — |

FortiGate becomes cheaper at ~17+ sites. Below that, AWS-native wins on cost — you
choose FortiGate for the NGFW feature set, not to save money at small scale. Full
crossover model in [`docs/cost-analysis.md`](docs/cost-analysis.md).

Two independent cost guards prevent runaway lab spend: the `trap cleanup EXIT` in
`deploy-and-test.sh` and the WatchdogStack auto-destroy.

---

## Pre-requisites

1. AWS CLI configured with a profile (`us-east-1`)
2. **Accept FortiGate PAYG terms** in [AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-wory773oau6wq) — one-time, required before first deploy
3. CDK bootstrapped: `AWS_PROFILE=<profile> npx cdk bootstrap`
4. Node.js ≥ 18
5. `npm ci` (never `npm install`) in `infra/` and `validator/` after a fresh clone

For the complete pre-flight checklist, see [`docs/OPERATIONS.md`](docs/OPERATIONS.md) §1.

---

## Quick start

```bash
git clone https://github.com/zimlama/fortigate-ha-aws-cdk
cd fortigate-ha-aws-cdk
git checkout master                  # default branch — the validated baseline

# Install + run all tests (no AWS needed)
(cd infra     && npm ci && npm test)   # 24 CDK assertion tests
(cd validator && npm ci && npm test)   # 20+ domain tests, ≥90% coverage

# Deploy + failover test + auto-destroy (~15 min, ~$1.50)
AWS_PROFILE=<profile> HA_PASSWORD='<secret>' \
  ADMIN_CIDR=<your-ip>/32 \
  ./scripts/deploy-and-test.sh
```

Exit code `0` = `FAILOVER PASSED ✅`. Everything is destroyed automatically via the
`trap cleanup EXIT` plus the WatchdogStack as backup. The full run log is written to
`/tmp/fgt-ha-run-<timestamp>.log` (survives the teardown — your forensic record).

> ⚠️ **Always deploy from `master`**. The `legacy/v1-initial` branch is the
> pre-fix snapshot and will fail validation (cluster never forms).
> See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for the full step-by-step.

## How this project evolves

This is not just a working lab — it's an **evolving engineering artifact**.
Every change follows a documented process: feature branch → PR → review →
CHANGELOG entry → ADR if the decision is non-obvious. The v1.0.0 → v1.1.0
journey is visible in the git log, in [`CHANGELOG.md`](CHANGELOG.md), and in
[`docs/ADR/0001-fgcp-heartbeat-self-referencing-sg.md`](docs/ADR/0001-fgcp-heartbeat-self-referencing-sg.md).

Full process documentation: [`docs/ENGINEERING_PROCESS.md`](docs/ENGINEERING_PROCESS.md).

---

## Why the validator is hexagonal

The validator could have been a bash script. It's not — because bash scripts aren't
testable, and the point of this repo is that **production-grade network automation
deserves production-grade engineering**.

```
Domain (pure TypeScript, zero I/O)
  FailoverOutcome · HAState · EipMigrationInvariant · MgmtReachabilityInvariant

Application (use case, depends on ports)        Ports (interfaces)
  ValidateFailoverUseCase                         CloudQueryPort · ReachabilityPort

Adapters (AWS boundary)
  Ec2CloudQuery (AWS SDK v3) · HttpsReachability
```

The pass/fail gate is EIP migration — the authoritative proof of failover:

```typescript
// EipMigrationInvariant — satisfied when the surviving (active) node holds the EIP
static evaluate(state: HAState): InvariantResult {
  const holder = state.eipHolder();
  if (!holder)                       return { satisfied: false, reason: 'no EIP holder found' };
  const active = state.activeNode();
  if (!active || holder.id !== active.id)
                                     return { satisfied: false, reason: 'EIP did not migrate' };
  return { satisfied: true };
}
```

> `MgmtReachabilityInvariant` (Port2) is captured as **informational** telemetry, not
> a gate — Port2 is data-plane and unreliable on a standby unit; Port4 (HA-MGMT) is
> the real management path. See lessons #9/#10.

---

## License

MIT — fork it, use it, break it.
