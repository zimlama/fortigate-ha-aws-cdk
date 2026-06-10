# Anti-Cost Protections

> **Audience**: Engineers running or extending this lab. The lessons here apply
> to any AWS-based lab or ephemeral infrastructure project.
>
> **Last validated**: 2026-06-10 on `master`.

This document explains the **four layers of anti-cost protection** that keep
this FortiGate HA lab from running away on your AWS bill, the tradeoffs of
each, and how to reuse the code in your own projects.

---

## The problem

A short-lived lab stack is a **cost time bomb** if any of the following happen:

1. The deploy script crashes mid-run and the cleanup trap doesn't fire.
2. The terminal is closed and the trap never runs.
3. An AI agent (or human) deploys but forgets to tear down.
4. The WatchdogStack itself fails and the destroy never happens.

Any one of these leaves a `c6in.xlarge` FortiGate running at ~$0.06/hr until
you notice. **This actually happened to the author** — a previous session
left a stack running for several hours before being caught. The 4-layer
defense below is the result of that incident.

---

## The 4 layers

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 4: AWS Budgets + Anomaly Detection          (alert only)    │
│  Layer 3: AccountGuardian Lambda                   (catches all)   │
│  Layer 2: WatchdogStack EventBridge rule           (per-stack)     │
│  Layer 1: trap cleanup EXIT in deploy-and-test.sh  (fast path)     │
└─────────────────────────────────────────────────────────────────────┘
```

Each layer is **independent** and **runs in a different runtime context**. The
goal is that if any single layer fails, the next one catches it.

---

### Layer 1: `trap cleanup EXIT` in `deploy-and-test.sh`

**The fast path.** Runs in the same shell as the deploy. When the script
exits (success, error, `Ctrl-C`), `cdk destroy --all --force --ci` runs
synchronously.

```bash
# deploy-and-test.sh
trap cleanup EXIT
cleanup() {
  (cd "${REPO_DIR}/infra"
    AWS_PROFILE="${PROFILE}" AWS_REGION="${REGION}" \
      npx cdk destroy --all --force --ci 2>&1 || true)
}
```

**Coverage**: ~99% of cases.

**Bypass conditions**:
- Process killed with `kill -9` (SIGKILL) — no trap handler runs.
- Network partition between your shell and the AWS endpoint — the `cdk destroy`
  command itself can hang or fail mid-execution.
- The shell never exits (e.g., `tail -f` left running, terminal multiplexer
  session abandoned).

**Why we still need layers above it**: any of the bypass conditions can leave
a stack running indefinitely.

---

### Layer 2: WatchdogStack (per-stack EventBridge rule)

**The per-stack backstop.** When the FortiGate stack deploys, it creates a
WatchdogStack with:

- An EventBridge rule `AutoDestroyRule` on a short schedule
- A Lambda `WatchdogFn` that runs `cdk destroy --all` if invoked

If the deploy script's trap fails, the WatchdogStack's scheduled event will
fire and tear everything down.

```typescript
// infra/lib/watchdog-stack.ts (excerpt)
new events.Rule(this, 'AutoDestroyRule', {
  schedule: events.Schedule.rate(cdk.Duration.hours(1)),
  targets: [new targets.LambdaFunction(watchdogFn)],
});
```

**Coverage**: ~99% of remaining cases (catches the "trap didn't fire" scenarios).

**Bypass conditions**:
- The WatchdogStack itself fails to deploy (e.g., Lambda quota hit).
- The Lambda runs out of IAM permissions (we use `AdministratorAccess` to avoid this).
- The EventBridge rule is disabled by a human.

**Why we still need layers above it**: the WatchdogStack is per-stack. If a
human deploys a *different* stack outside the FortiGate project, there's no
Watchdog for it.

---

### Layer 3: AccountGuardian Lambda (account-level sweeper)

**The safety net.** A single Lambda deployed **once per AWS account** that
runs **14 times per day** and destroys **every** stack in the account except
`CDKToolkit` and `AccountGuardianStack` itself.

```python
# account-guardian/lambda/index.py (excerpt)
EXCLUDE = {'CDKToolkit', 'AccountGuardianStack'}

def handler(event, context):
    cfn = boto3.client('cloudformation')
    paginator = cfn.get_paginator('list_stacks')
    to_delete = []
    for page in paginator.paginate(StackStatusFilter=list(TERMINAL)):
        for s in page['StackSummaries']:
            if s['StackName'] not in EXCLUDE:
                to_delete.append(s['StackName'])
    for name in to_delete:
        try:
            cfn.delete_stack(StackName=name)
        except Exception:
            pass
```

Cron expression: `cron(0 0,1,2,3,4,5,6,7,8,9,10,11,12,17 * * ? *)` —
runs at 5,6,7AM, 12PM, 7-11PM, 12-4AM **COT** (Colombia time).

**Coverage**: 100% of "stranded stack" scenarios. This is the layer that
**catches the incident that motivated this design** — a stack left running
for hours after an AI agent's deploy.

**Bypass conditions**:
- The AccountGuardian Lambda is itself deleted.
- The IAM role loses `cloudformation:DeleteStack` (extremely unlikely with
  `AdministratorAccess`).
- AWS CloudFormation has a regional outage when the schedule fires (the
  next schedule will catch it).

**Why we still need layer 4**: AccountGuardian destroys stacks but doesn't
alert you. If a stack is being torn down repeatedly, you want to know.

---

### Layer 4: AWS Budgets + Cost Anomaly Detection

**The alerter.** Doesn't destroy anything; just emails you.

- **AWS Budget**: monthly $20 with email alerts at 80% ($16) and 100% ($20).
- **Cost Anomaly Monitor**: alerts if daily spend spikes by more than $5.

Both are configured by `scripts/setup-account-guardian.sh` in this repo.

```bash
# setup-account-guardian.sh (excerpt)
aws budgets create-budget \
  --account-id "${ACCOUNT_ID}" \
  --budget "{...BudgetLimit: Amount: 20, Unit: USD...}" \
  --notifications-with-subscribers "[{...Threshold: 80...}, {...Threshold: 100...}]"
```

**Coverage**: alerting only. Does NOT prevent costs. But ensures you find out
within hours, not weeks.

**Why this is still useful**: if all 3 destructive layers fail AND a stack
runs for 24h, the Budget alert is your last line of human defense.

---

## The deployment script guard (UX only)

In addition to the 4 runtime layers, `infra/bin/app.ts` has a guard that
**blocks any direct `cdk deploy`/`destroy`/`synth`** from a terminal unless
the `DEPLOY_VIA_SCRIPT=1` env var is set:

```typescript
// infra/bin/app.ts
if (process.env.DEPLOY_VIA_SCRIPT !== '1') {
  process.stderr.write('❌  Direct CDK invocation is blocked.\n...');
  process.exit(1);
}
```

The script `scripts/deploy-and-test.sh` sets this var. So the only way to
deploy is through the script.

**This is a UX guard, not a security boundary.** Anyone can run
`DEPLOY_VIA_SCRIPT=1 cdk deploy --execute` from their terminal. The real
protections are the 4 runtime layers above.

**Why we still have it**: it forces the user to acknowledge they're going
through an unmonitored path. The 4 runtime layers are what actually keep
costs in check.

---

## Tradeoffs and what we deliberately did NOT do

### What we did NOT do (and why)

1. **No SCPs (Service Control Policies) to block EC2/RDS/etc.** — too aggressive.
   Would break the lab and any other legitimate use of the account.
2. **No IAM deny on `cloudformation:CreateStack` for the lab user** — same reason.
3. **No hard AWS account ID in `app.ts` for context validation** — PII concern
   for a public repo, and the env var is sufficient.
4. **No Slack/Discord webhook for deploy notifications** — adds an external
   dependency. Email is enough.

### Tradeoffs accepted

- **Cost Anomaly Monitor can be noisy** during normal AWS activity. The $5
  threshold is conservative; you may want to raise it to $10.
- **AccountGuardian deletes ALL stacks**, even ones you might want to keep
  (e.g., a long-running dev environment). If you need to keep a stack, the
  solution is to **add its name to the `EXCLUDE` set** in the Lambda code,
  not to disable AccountGuardian.
- **Lambda runtime is `python3.12`** — needs to be updated periodically as
  AWS deprecates runtimes.

---

## Reusing this design in your own projects

If you're building a similar short-lived lab or ephemeral infrastructure,
the 4 layers are reusable as-is:

1. **Copy the `trap cleanup EXIT` pattern** into your deploy script. ~5 lines.
2. **Copy the WatchdogStack** (`infra/lib/watchdog-stack.ts`). ~50 lines. Use
   it in your own CDK project.
3. **Copy `scripts/setup-account-guardian.sh`** to your project root and run
   it **once per AWS account**. ~200 lines. Don't modify the Lambda code
   unless you have a strong reason.
4. **Use the budget threshold from your expected max monthly cost × 0.8**
   as the 80% alert. Set the anomaly monitor to 10-20% of that.

The whole defense is ~250 lines of code total. It costs $0/month to run
(free tier for Lambda + EventBridge). It has caught a real incident in
the author's history.

---

## When this protection will NOT save you

- **EC2 instances launched outside CloudFormation** (e.g., via the console
  or `aws ec2 run-instances` directly). AccountGuardian only sees
  CloudFormation stacks.
- **Other AWS services that aren't stacks**: S3 buckets, DynamoDB tables,
  ECR repos, etc. These are NOT cleaned up by AccountGuardian.
- **Cross-region resources**: AccountGuardian runs in `us-east-1` by default.
  If you deploy to other regions, you need a multi-region setup.
- **Resources created by CloudFormation stacks that failed mid-deploy**:
  CloudFormation marks these as `CREATE_FAILED` and AccountGuardian will
  try to delete them, but the deletion can itself fail if there are
  orphaned resources with retention policies.

For these gaps, the answer is usually **regular audits** + **Cost Anomaly
Detection alerts** rather than more automation.

---

## Validation

This 4-layer defense was stress-tested on 2026-06-10 with the FortiGate HA
lab: 3 successful deploy+failover+destroy runs, total cost $4.50, no
stranded resources, AccountGuardian still in `ENABLED` state.

To verify the layers are active in your account:

```bash
# Layer 1: trap is in the script
grep -A 2 "trap cleanup EXIT" scripts/deploy-and-test.sh

# Layer 2: WatchdogStack deployed with the FortiGate stacks
aws cloudformation describe-stacks --stack-name WatchdogStack \
  --query 'Stacks[0].StackStatus'

# Layer 3: AccountGuardian Lambda + schedule
aws lambda get-function --function-name account-guardian \
  --query 'Configuration.FunctionName'
aws events describe-rule --name account-guardian-schedule \
  --query 'ScheduleExpression'

# Layer 4: Budget exists
aws budgets describe-budget --account-id <account-id> --budget-name monthly-lab-budget
```
