# fortigate-ha-aws-cdk

**In AWS, FortiGate's MGMT interface doesn't fail over.**
When the Passive node takes over, you lose management access — silently.
This repo proves it, fixes it, and validates the fix automatically.

[![Validator](https://github.com/zimlama/fortigate-ha-aws-cdk/actions/workflows/ci.yml/badge.svg?job=validator)](https://github.com/zimlama/fortigate-ha-aws-cdk/actions/workflows/ci.yml)
[![Infra](https://github.com/zimlama/fortigate-ha-aws-cdk/actions/workflows/ci.yml/badge.svg?job=infra)](https://github.com/zimlama/fortigate-ha-aws-cdk/actions/workflows/ci.yml)
![Coverage](https://img.shields.io/badge/coverage-%E2%89%A590%25-brightgreen)
![CDK](https://img.shields.io/badge/CDK-v2%20TypeScript-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

> 🎬 **Demo coming soon** — deploy → failover → destroy in under 30 min

---

## The problem

FortiGate HA on AWS uses the FGCP protocol to elect a new Active node when the current one fails. The failover callback reassigns the Elastic IP and updates route tables — but **it does not migrate the MGMT interface**.

If you configure admin access on the MGMT port (the default), failover works at the network level but you lose the ability to manage the new Active node. In a real incident, that's the moment you need it most.

**The fix is one config line**: move admin access to Port2 (INTERNAL), which IS covered by the failover callback.

```
config system interface
  edit "port2"
    set allowaccess https ssh   ← admin lives here, not on mgmt
  next
end
```

This repo deploys the full architecture, triggers a real failover, and automatically verifies that Port2 management survives — across two Availability Zones.

---

## Architecture

```
                         Internet
                            │
                     Internet Gateway
                            │
         ┌──────────────────┴──────────────────┐
         │              VPC  10.0.0.0/16         │
         │                                        │
         │   us-east-1a           us-east-1b      │
         │  ┌─────────────┐   ┌─────────────┐    │
         │  │ public-1a   │   │ public-1b   │    │
         │  │ 10.0.1.0/24 │   │10.0.11.0/24 │    │
         │  │  Port1  EIP─┼───►EIP migrates │    │
         │  ├─────────────┤   ├─────────────┤    │
         │  │ private-1a  │   │ private-1b  │    │
         │  │ 10.0.2.0/24 │   │10.0.12.0/24 │    │
         │  │  Port2 MGMT ◄───── RT updated │    │
         │  ├─────────────┤   ├─────────────┤    │
         │  │   ha-1a     │   │   ha-1b     │    │
         │  │ 10.0.3.0/24 │   │10.0.13.0/24 │    │
         │  │  Port3 ◄────┼703┼─► Port3     │    │
         │  └──────┬──────┘   └──────┬──────┘    │
         │         │                  │            │
         │   FortiGate          FortiGate          │
         │    ACTIVE             PASSIVE            │
         │  c6in.xlarge        c6in.xlarge          │
         │  priority 200       priority 100         │
         └────────────────────────────────────────┘
```

Failover is 100% API-driven — across AZs there is no L2, so the FGCP callback must call `ec2:AssociateAddress` (EIP) and `ec2:ReplaceRoute` (route tables). The hexagonal validator confirms both happened and that Port2 management is reachable on the new Active.

---

## What's inside

```
fortigate-ha-aws-cdk/
├── docs/
│   ├── 00-PRD.md               Product requirements
│   ├── 01-RFC.md               6 architecture decisions
│   ├── 02-HLD.md               High level design + failover sequence
│   ├── 03-LLD.md               CDK construct details, SG rules, IAM
│   ├── cost-analysis.md        FortiGate PAYG vs AWS-native secure edge
│   └── diagrams/               draw.io source (editable)
├── infra/                      CDK TypeScript — 3 stacks
│   ├── lib/network-stack.ts    VPC, 6 subnets, IGW, 3 SGs
│   ├── lib/fortigate-stack.ts  2× c6in.xlarge, 6 ENIs, EIP, IAM role
│   ├── lib/watchdog-stack.ts   EventBridge → Lambda → auto-destroy
│   └── test/                   24 CDK fine-grained assertion tests
├── validator/                  Hexagonal failover validator
│   ├── src/domain/             Pure domain — FailoverOutcome, HAState, invariants
│   ├── src/application/        ValidateFailoverUseCase (depends on ports, not AWS)
│   ├── src/adapters/           EC2 + HTTPS adapters (boundary I/O, excluded from tests)
│   └── test/                   20 tests, ≥90% coverage, zero real AWS calls
└── scripts/
    ├── deploy-and-test.sh      Full pipeline with auto-destroy trap
    └── ha-test.sh              Terminate active → run validator
```

---

## Engineering approach

This isn't a collection of scripts. The design follows the same process used in production:

| Artifact | What it captures |
|---|---|
| **PRD** | 3 user stories with acceptance criteria |
| **RFC** | 6 formal architecture decisions (Context → Decision → Consequences) |
| **HLD** | 2-AZ topology, failover sequence, IAM minimum permissions |
| **LLD** | CDK construct details, SG rules, UserData config |
| **TDD** | Tests written first — domain → application → coverage gate |
| **Hexagonal architecture** | Domain is pure TypeScript, zero AWS SDK imports; adapters are the only boundary |

The validator's domain never imports `@aws-sdk`. `FakeCloudQuery` and `FakeReachability` make every test deterministic and instant — no mocks, no `jest.fn()`, no real AWS calls. `pollIntervalMs: 10` in tests means the timeout scenario runs in milliseconds, not 120 seconds.

---

## Cost

| Scenario | Monthly | Per lab run (30 min) |
|---|---|---|
| FortiGate HA PAYG (`c6in.xlarge` × 2) | ~$1,829 flat | ~$1.34 |
| AWS-native (Network Firewall 2-AZ + S2S VPN + TGW) | ~$613 + $73/site | — |

FortiGate becomes cheaper at ~17+ sites. Below that, AWS-native wins on cost. You choose FortiGate for the NGFW feature set and single-vendor operations — not to save money at small scale. Full crossover model with sensitivity analysis in [`docs/cost-analysis.md`](docs/cost-analysis.md).

---

## Pre-requisites

1. AWS CLI configured with a profile (default: `test-admin`, `us-east-1`)
2. **Accept FortiGate PAYG terms** in [AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-wory773oau6wq) — one-time, required before first deploy
3. CDK bootstrapped: `AWS_PROFILE=test-admin npx cdk bootstrap`
4. Node.js ≥ 18

---

## Quick start

```bash
git clone https://github.com/zimlama/fortigate-ha-aws-cdk
cd fortigate-ha-aws-cdk

# Run all tests (no AWS needed)
cd infra && npm ci && npm test
cd ../validator && npm ci && npm test

# Deploy + failover test + auto-destroy (~30 min, ~$1.34)
cd ..
AWS_PROFILE=test-admin HA_PASSWORD=<secret> \
  ADMIN_CIDR=<your-ip>/32 \
  ./scripts/deploy-and-test.sh
```

Exit code `0` = `FAILOVER PASSED ✅`. All resources are destroyed automatically via the `trap cleanup EXIT` + the WatchdogStack Lambda as a backup.

---

## Why the validator is hexagonal

The validator could have been a bash script. It's not — because bash scripts aren't testable, and the point of this repo is that **production-grade network automation deserves production-grade engineering**.

```
Domain (pure TypeScript, zero I/O)
  FailoverOutcome · HAState · EipMigrationInvariant · MgmtReachabilityInvariant

Application (use case, depends on ports)
  ValidateFailoverUseCase

Ports (interfaces)
  CloudQueryPort · ReachabilityPort

Adapters (AWS boundary — excluded from unit tests)
  Ec2CloudQuery (AWS SDK v3) · HttpsReachability
```

The invariant that closes the loop on RFC-001:

```typescript
// MgmtReachabilityInvariant — this is what the whole repo exists to test
evaluate(activeNode: HANode, port2Reachable: boolean): InvariantResult {
  if (!port2Reachable) {
    return { satisfied: false, reason: 'Port2 MGMT unreachable after failover' };
  }
  return { satisfied: true };
}
```

---

## License

MIT — fork it, use it, break it.
