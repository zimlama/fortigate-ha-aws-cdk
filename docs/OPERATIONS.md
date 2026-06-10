# Operations — How to run this repo end-to-end

> **Audience**: Anyone landing on this repo who wants to go from a fresh clone to a
> validated FortiGate Active-Passive HA failover on AWS.
>
> **Last validated**: 2026-06-10 against `master` (commit `8177fbb`).

This is the single source of truth for **how to operate the lab**. If anything in
`README.md` or `docs/03-DEPLOYMENT-GUIDE.md` contradicts this file, **this file wins**.

---

## 0. Architecture in 60 seconds

Three CDK stacks deploy in order:

```
NetworkStack    →  VPC, 6 subnets (2 AZs × {public, mgmt, ha, private}), 4 SGs
FortiGateStack  →  2× c6in.xlarge FortiGates, 4 ENIs each, EIPs, IAM role
BastionStack    →  SSM-managed bastion, S3 bucket for the validator artifact
WatchdogStack   →  EventBridge → Lambda → auto-destroy (cost guard)
```

After deploy, `deploy-and-test.sh` runs `ha-test.sh` which terminates the Active
FortiGate and the hexagonal validator (`validator/`) confirms the surviving unit
re-associated the WAN EIP on poll #1.

**Full architecture**: see `docs/02-HLD.md` and `docs/diagrams/02-HLD-fortigate-ha.png`.
**Why this design**: see `docs/04-fortinet-ha-reference-design.md` and
`docs/ADR/0001-fgcp-heartbeat-self-referencing-sg.md`.

---

## 1. Pre-requisites (verify before cloning)

| Tool | Min version | How to verify |
|---|---|---|
| Node.js | 18 | `node --version` |
| npm | 9 | `npm --version` (bundled with Node 18+) |
| AWS CLI | 2.x | `aws --version` |
| git | 2.30+ | `git --version` |
| `gh` (optional) | 2.x | `gh --version` |

### AWS account

- An active AWS account (this guide was tested on a sandbox account / `us-east-1`).
- IAM principal with permissions for EC2, VPC, IAM, Lambda, EventBridge, S3, CloudFormation.
- Verify identity:
  ```bash
  aws sts get-caller-identity
  # Expected: { "Account": "<your-account-id>", "Arn": "arn:aws:iam::<account>:user/..." }
  ```
- Region set to `us-east-1` (or override with `AWS_REGION=...` everywhere).

### One-time AWS Marketplace acceptance

The FortiGate PAYG AMI is a Marketplace product. You must accept the terms **once
per AWS account** before the first deploy. Open the listing, click **Continue to
subscribe**, then **Accept terms**:

- [FortiGate-VM PAYG on AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-wory773oau6wq)

If you skip this step, the CDK deploy fails at the `aws ec2 describe-images` call
inside `network-stack.ts` with `InvalidAMIID.NotFound` or `UnauthorizedOperation`.

### CDK bootstrap (one-time per account/region)

```bash
AWS_PROFILE=<your-profile> AWS_REGION=us-east-1 npx cdk bootstrap
```

If `CDKToolkit` stack already exists, this is a no-op. To check:

```bash
aws cloudformation describe-stacks --stack-name CDKToolkit --region us-east-1 \
  --query 'Stacks[0].StackStatus' --output text
# Expected: CREATE_COMPLETE  or  UPDATE_COMPLETE
```

---

## 2. Clone, install, verify (no AWS needed)

```bash
git clone https://github.com/zimlama/fortigate-ha-aws-cdk
cd fortigate-ha-aws-cdk
git checkout master             # default branch — the validated baseline
```

> ⚠️ **Do not deploy from `legacy/v1-initial`** — that branch is the pre-fix
> snapshot and the validator will fail (cluster never forms). See
> `docs/lessons-learned.md` lesson #8 for why.

### Install dependencies

The repo has two npm projects. `node_modules/` is gitignored — always run `npm ci`,
never `npm install`, for reproducibility.

```bash
(cd infra     && npm ci)   # AWS CDK + Jest + ts-jest
(cd validator && npm ci)   # Hexagonal validator + Jest
```

### Run the test suites (no AWS calls)

```bash
(cd infra     && npm test)   # 24 CDK fine-grained assertion tests
(cd validator && npm test)   # 20+ domain tests, ≥90% coverage gate
```

**Expected output**: both end with `Tests: X passed, Y total` and no failures.
The validator's domain layer is pure TypeScript — it never touches AWS, so this
is safe to run anywhere.

---

## 3. Deploy + failover test

The pipeline runs end-to-end in one command. **It auto-destroys all stacks when
it exits**, so the lab cost is bounded to a single run.

```bash
AWS_PROFILE=<your-profile> \
AWS_REGION=us-east-1 \
ADMIN_CIDR=0.0.0.0/0 \                # CHANGE: restrict to your IP/32 in production
HA_PASSWORD='<your-fortigate-ha-password>' \
./scripts/deploy-and-test.sh
```

### What happens, in order

1. **T+0s** — Build validator (`tsc`), package as `dist/` + `node_modules` tarball.
2. **T+~2m** — `cdk deploy --all` brings up NetworkStack → FortiGateStack → BastionStack → WatchdogStack.
3. **T+~3m** — Validator tarball uploaded to bastion's S3 bucket.
4. **T+~3m → T+~10m** — **7-minute sleep** (configurable via `HA_BOOT_WAIT`) for FortiGate VMs to boot FortiOS, apply UserData config, and establish the FGCP unicast heartbeat.
5. **T+~10m** — `ha-test.sh` runs:
   - **Pre-flight**: SSH each unit on Port4 (HA-MGMT), verify `get system ha status` shows `number of member: 2`.
   - **Inject fault**: Terminate the Active FortiGate.
   - **Poll**: Watch the EIP holder. Expected: surviving unit re-associates the EIP on poll #1 (< 10s).
   - **Validate**: Hexagonal validator confirms `EipMigrationInvariant` is satisfied.
   - **Capture**: CloudTrail lookback for `AssociateAddress` / `DisassociateAddress` / `ReplaceRoute` in the last 30 min.
6. **T+~12m** — `trap cleanup EXIT` runs `cdk destroy --all --force --ci`.
7. **End** — All stacks destroyed. **Total cost: ~$1.50**.

### Success / failure indicators

- `PIPELINE COMPLETE — FAILOVER PASSED ✅` — done. The EIP migrated and the validator confirmed it.
- `Failover validation failed.` — the script will still destroy all stacks (the trap is non-conditional). Read the log in `/tmp/fgt-ha-run-<timestamp>.log` and go to §5 (Troubleshooting).

### Persisted logs

The full run output is tee'd to `/tmp/fgt-ha-run-YYYYMMDD-HHMMSS.log`. This file
**survives the auto-destroy** — it is your forensic record.

```bash
ls -lt /tmp/fgt-ha-run-*.log | head -3
# Then read the most recent one.
```

---

## 4. Cost model

| Scenario | Monthly | Per lab run (~30 min) |
|---|---|---|
| FortiGate HA PAYG (`c6in.xlarge` × 2) | ~$1,829 flat | **~$1.50** |
| AWS-native (Network Firewall 2-AZ + S2S VPN + TGW) | ~$613 + $73/site | — |

Two independent cost guards prevent runaway lab spend:

1. **`trap cleanup EXIT`** in `deploy-and-test.sh` — runs `cdk destroy --all --force --ci` when the script exits, under any condition (success, failure, Ctrl-C).
2. **WatchdogStack** — a separate EventBridge + Lambda that auto-destroys the stacks if the script crashes hard and the trap doesn't fire.

Full cost analysis with sensitivity modelling in `docs/cost-analysis.md`.

---

## 5. Troubleshooting

| Symptom | Likely cause | Where to look |
|---|---|---|
| `cdk synth` fails with `Cannot find name 'process'` | `node_modules/` missing | `(cd infra && npm ci)` |
| `cdk deploy` fails with `InvalidAMIID.NotFound` | Marketplace terms not accepted | §1 above, accept and retry |
| `cdk deploy` fails with `Stack CDKToolkit does not exist` | Bootstrap not run | `npx cdk bootstrap` |
| Validator returns `no EIP holder found` after terminating Active | FGCP cluster never formed | `docs/lessons-learned.md` lesson #8 |
| `ssh: connect to host ... port 22: Connection timed out` on Port2/Port4 | SG ingress or wrong port | `docs/05-troubleshooting-ha-runbook.md` §4 |
| Deploy takes > 15 min with no progress | Quota limits or service issues | Check CloudFormation console for stuck resource |

**Field guide**: `docs/05-troubleshooting-ha-runbook.md` covers the three telemetry
layers (AWS control plane, FortiOS boot, FortiOS runtime) and the failure decision
tree. Read it before debugging a non-trivial failure — instrumenting first saves
hours of theorizing.

**Post-mortems of real failures in this project**: `docs/lessons-learned.md` (10 lessons, ordered by impact).

---

## 6. Tear-down (manual)

The trap and Watchdog handle teardown automatically. If you used `SKIP_DESTROY=1`
to keep the stacks up for manual inspection:

```bash
AWS_PROFILE=<your-profile> AWS_REGION=us-east-1 \
  (cd infra && npx cdk destroy --all --force)
```

Verify nothing leaked:

```bash
aws cloudformation list-stacks --region us-east-1 \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[?contains(StackName, `NetworkStack`) || contains(StackName, `FortiGateStack`) || contains(StackName, `BastionStack`) || contains(StackName, `WatchdogStack`)].StackName' \
  --output text
# Expected: empty
```

---

## 7. Related docs

| Doc | What it covers |
|---|---|
| `README.md` | First-impression overview, architecture diagram, why hexagonal |
| `docs/00-PRD.md` | Product requirements + 3 user stories |
| `docs/01-RFC.md` | 6 architecture decisions in Context → Decision → Consequences format |
| `docs/02-HLD.md` | High-level design + failover sequence |
| `docs/03-LLD.md` | CDK construct details, SG rules, IAM permissions |
| `docs/04-fortinet-ha-reference-design.md` | Official Fortinet 8.0 reference vs. our implementation |
| `docs/05-troubleshooting-ha-runbook.md` | Field guide — three telemetry layers, failure tree |
| `docs/06-cdk-preflight-design-checklist.md` | Design invariants that must hold before merge |
| `docs/ADR/0001-fgcp-heartbeat-self-referencing-sg.md` | The decision that unblocked failover |
| `docs/cost-analysis.md` | FortiGate PAYG vs. AWS-native, with crossover analysis |
| `docs/lessons-learned.md` | Post-mortems of real failures (10 lessons) |
| `docs/ENGINEERING_PROCESS.md` | How the project evolves — branching, PR, CHANGELOG, ADR |
| `CHANGELOG.md` | Release-by-release user-visible changes |
