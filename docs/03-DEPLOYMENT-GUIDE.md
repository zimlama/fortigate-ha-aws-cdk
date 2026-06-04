---
title: Deployment & Failover Test Guide
date: 2026-06-04
author: Leonardo Mejía
---

# 🚀 Deployment & Failover Test Guide

Complete step-by-step manual to prepare, deploy, and validate the FortiGate HA cluster on AWS.

---

## Prerequisites

### Required

- **AWS Account** (active, not a trial)
- **AWS CLI v2** installed locally
- **AWS Credentials** configured (`~/.aws/credentials`)
- **Node.js 18+** + npm installed
- **Appropriate IAM permissions** (EC2, VPC, IAM, Lambda, EventBridge)
- **FortiGate AMI accepted** in AWS Marketplace

### Optional (for recording)

- QuickTime (Mac) or OBS for screen recording

---

## STEP 1: Validate AWS CLI & Credentials

### 1.1 Check AWS CLI is installed

```bash
aws --version
```

Expected output: `aws-cli/2.x.x`

### 1.2 Verify AWS credentials and identity

```bash
aws sts get-caller-identity
```

Expected output:
```json
{
    "UserId": "AIDAQ6C7WAOGELCU7GBSR",
    "Account": "064625181580",
    "Arn": "arn:aws:iam::064625181580:user/leonardo.admin.aws"
}
```

**If error:** Configure credentials:
```bash
aws configure
```

### 1.3 Check active profile and region

```bash
aws configure list
```

Expected:
- `region`: `us-east-1` ✅
- `access_key` and `secret_key`: Set ✅

### 1.4 Verify IAM permissions

```bash
aws iam list-attached-user-policies --user-name <your-username>
```

Or check group policies:
```bash
aws iam list-attached-group-policies --group-name <your-group>
```

**Required permissions:** `AdministratorAccess` or equivalent (EC2, VPC, IAM, Lambda, EventBridge, CloudWatch).

---

## STEP 2: Accept FortiGate AMI in AWS Marketplace

### 2.1 Open AWS Marketplace

1. Go to [AWS Marketplace](https://aws.amazon.com/marketplace)
2. Search for: `FortiGate-VM64-AWSONDEMAND`
3. Click on the result (ensure it says **AWSONDEMAND**, not "Free Trial")

### 2.2 Subscribe to the AMI

1. Click **"View purchase options"** (orange button)
2. Click **"Subscribe"** or **"Continue to Subscribe"**
3. Accept terms and conditions
4. Confirm subscription

**Expected response:**
```
You've successfully purchased Fortinet FortiGate VM Next-Generation Firewall
Agreement status: Active
Pricing model: Usage-based
```

### 2.3 Verify subscription is active

```bash
aws ec2 describe-images \
  --owners 679593333241 \
  --filters "Name=name,Values=FortiGate-VM64-AWSONDEMAND*" \
  --region us-east-1 \
  --query 'Images[0].[ImageId,Name]' \
  --output text
```

Expected: Returns ImageId + Image name.

---

## STEP 3: Bootstrap CDK environment (one-time per account/region)

> ⚠️ **This step is mandatory and commonly missed.** Even if the SSM parameter
> `/cdk-bootstrap/hnb659fds/version` exists, the deploy will fail if the CDK S3 assets
> bucket was deleted. Always verify before deploying.

### 3.1 Verify bootstrap exists

```bash
aws s3 ls s3://cdk-hnb659fds-assets-$(aws sts get-caller-identity --query Account --output text)-us-east-1 2>&1
```

- If bucket is listed → bootstrap is OK, skip to Step 4.
- If `NoSuchBucket` → run bootstrap below.

### 3.2 Run CDK bootstrap (if needed)

```bash
cd repo/infra
npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1
```

Expected output: `✅ Environment aws://XXXXXXXXXXXX/us-east-1 bootstrapped.`
Duration: ~2 minutes. Only required once per account/region.

---

## STEP 4: Install Dependencies

### 4.1 Install npm packages

```bash
cd repo/infra && npm install
```

Expected: `added X packages, audited Y packages`.

---

## STEP 5: Synthesize CDK (Validate Configuration)

### 5.1 Synthesize templates

Pass context values via CLI — **do NOT hardcode `haPassword` in `cdk.json`** (this is a public repo):

```bash
npx cdk synth \
  -c adminCidr=$(curl -s ifconfig.me)/32 \
  -c haPassword=YourPasswordHere 2>&1 | tail -5
```

**What this does:**
- Looks up FortiGate AMI in your account/region
- Generates CloudFormation templates
- Validates configuration syntax

**Expected output:**
```
Searching for AMI in 064625181580:us-east-1
Successfully synthesized to /path/to/cdk.out
Supply a stack id (NetworkStack, FortiGateStack, WatchdogStack) to display its template.
```

**If error:** Check AWS CLI credentials, Marketplace AMI subscription, and CDK bootstrap.

---

## STEP 4: Install Dependencies

### 4.1 Install npm packages

```bash
npm install
```

Expected: `added X packages, audited Y packages`.

### 4.2 Verify installation

```bash
npm list | head -20
```

Expected packages:
- `aws-cdk-lib`
- `aws-cdk`
- `typescript`
- `ts-node`

---

## STEP 5: Synthesize CDK (Validate Configuration)

### 5.1 Synthesize templates

```bash
npx cdk synth
```

**What this does:**
- Looks up FortiGate AMI in your region
- Generates CloudFormation templates
- Validates configuration syntax

**Expected output:**
```
Searching for AMI in 064625181580:us-east-1
Successfully synthesized to /path/to/cdk.out
Supply a stack id (NetworkStack, FortiGateStack, WatchdogStack) to display its template.
```

**If error:** Check cdk.json, AWS CLI credentials, and Marketplace AMI subscription.

---

## STEP 6: Deploy to AWS (CREATE INFRASTRUCTURE)

### 6.1 Use the pipeline script (recommended)

The script handles build → deploy → failover test → auto-destroy in one command:

```bash
cd repo
HA_PASSWORD=YourPasswordHere \
  ADMIN_CIDR=$(curl -s ifconfig.me)/32 \
  ./scripts/deploy-and-test.sh
```

No `AWS_PROFILE` needed if using the `default` profile.

### 6.2 Or deploy manually (step by step)

```bash
cd repo/infra
npx cdk deploy --all \
  --require-approval never \
  -c adminCidr=$(curl -s ifconfig.me)/32 \
  -c haPassword=YourPasswordHere
```

**When prompted:** `Do you wish to continue?` → Type `y` and press Enter.

**What gets created:**
1. **NetworkStack:** VPC (10.0.0.0/16), 6 subnets, IGW, route tables, 3 security groups
2. **FortiGateStack:** 2× EC2 instances (c6in.xlarge), 6 ENIs, EIP, IAM role
3. **WatchdogStack:** EventBridge rule + Lambda (auto-destroys infra after 30 min)

**Duration:** ~5-10 minutes.

**Expected output at end:**
```
✅ Deployment successful
Stack outputs:
- FgtActiveManagementIP: 10.0.2.x
- FgtPassiveManagementIP: 10.0.12.x
- EIP (Public WAN): xxx.xxx.xxx.xxx
```

---

## STEP 7: Verify Deployment

### 7.1 Check stack status in AWS Console

```bash
aws cloudformation describe-stacks \
  --region us-east-1 \
  --query 'Stacks[*].[StackName,StackStatus]' \
  --output table
```

Expected: All stacks show `CREATE_COMPLETE`.

### 7.2 Verify EC2 instances are running

```bash
aws ec2 describe-instances \
  --region us-east-1 \
  --filters "Name=tag:FortigateHACluster,Values=fgt-ha-demo" \
  --query 'Reservations[*].Instances[*].[InstanceId,InstanceType,State.Name,Tags[?Key==`FortigateHARole`].Value|[0]]' \
  --output table
```

Expected:
```
| InstanceId      | InstanceType | State | Role    |
|-----------------|--------------|-------|---------|
| i-xxxxxxxxxxxx  | c6in.xlarge  | running | active |
| i-xxxxxxxxxxxx  | c6in.xlarge  | running | passive |
```

### 7.3 Check EIP assignment

```bash
aws ec2 describe-addresses \
  --region us-east-1 \
  --filters "Name=tag:FortigateHACluster,Values=fgt-ha-demo" \
  --query 'Addresses[*].[PublicIp,AssociationId,NetworkInterfaceId]' \
  --output table
```

Expected: EIP is **associated** with Active's Port1 (eni-xxxxxxxxx).

---

## STEP 8: Access FortiGate Management Interface

### 8.1 Get FGT-Active management IP

```bash
aws ec2 describe-instances \
  --region us-east-1 \
  --filters "Name=tag:FortigateHARole,Values=active" \
  --query 'Reservations[*].Instances[0].PrivateIpAddress' \
  --output text
```

Note the IP (e.g., `10.0.2.50`).

### 8.2 SSH into Active (via bastion or VPN)

```bash
# Option 1: If you have direct VPC access
ssh -i <your-key.pem> admin@<ACTIVE_MGMT_IP>
# Default password: blank (no password required initially)

# Option 2: If behind NAT, use EC2 Instance Connect
aws ssm start-session \
  --target i-xxxxxxxxxxxx \
  --region us-east-1
```

### 8.3 Verify HA status

Once logged in:
```
get sys ha status
```

Expected:
```
HA Health Status: OK
HA Enabled: enable
HA Mode: A-P
This is the ACTIVE unit
```

---

## STEP 9: Execute Failover Test

### 9.1 **START RECORDING** (if documenting)

```bash
# On Mac:
# Cmd + Space → QuickTime Player → File → New Screen Recording → Start
```

### 9.2 Verify initial state (Active/Passive)

```bash
# Terminal 1: Watch Active instance
aws ec2 describe-instances \
  --region us-east-1 \
  --filters "Name=tag:FortigateHARole,Values=active" \
  --query 'Reservations[*].Instances[0].[InstanceId,State.Name]' \
  --output table

# Terminal 2: Watch Passive instance
aws ec2 describe-instances \
  --region us-east-1 \
  --filters "Name=tag:FortigateHARole,Values=passive" \
  --query 'Reservations[*].Instances[0].[InstanceId,State.Name]' \
  --output table
```

Expected: Both running.

### 9.3 Verify EIP assignment (before failover)

```bash
aws ec2 describe-addresses \
  --region us-east-1 \
  --filters "Name=tag:FortigateHACluster,Values=fgt-ha-demo" \
  --query 'Addresses[0].[PublicIp,AssociationId]' \
  --output table
```

Note the **AssociationId** and **NetworkInterfaceId** (should be Active's Port1).

### 9.4 Terminate FGT-Active (TRIGGER FAILOVER)

```bash
# Get Active instance ID
ACTIVE_ID=$(aws ec2 describe-instances \
  --region us-east-1 \
  --filters "Name=tag:FortigateHARole,Values=active" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)

# Terminate it
aws ec2 terminate-instances --instance-ids $ACTIVE_ID --region us-east-1
```

**What happens next:**
- Active instance terminates (State: `shutting-down` → `terminated`)
- Passive detects heartbeat loss on Port3 (~3 sec)
- FGCP elects new Active
- EIP migrates: `ec2:DisassociateAddress` + `ec2:AssociateAddress`
- Route tables update: private-1a and private-1b routes point to new Active's Port2

### 9.5 Monitor failover in real-time

**Terminal 1:** Watch instance state changes

```bash
watch -n 2 'aws ec2 describe-instances \
  --region us-east-1 \
  --filters "Name=tag:FortigateHACluster,Values=fgt-ha-demo" \
  --query "Reservations[*].Instances[*].[Tags[?Key==\`FortigateHARole\`].Value|[0],State.Name]" \
  --output table'
```

**Terminal 2:** Watch EIP migration

```bash
watch -n 2 'aws ec2 describe-addresses \
  --region us-east-1 \
  --filters "Name=tag:FortigateHACluster,Values=fgt-ha-demo" \
  --query "Addresses[0].[PublicIp,AssociationId,NetworkInterfaceId]" \
  --output table'
```

**Expected sequence:**
```
T+0s:  Active instance: running → shutting-down
T+3s:  Heartbeat lost on Passive, FGCP failover initiated
T+5s:  EIP DisassociateAddress from old Active's Port1
T+6s:  EIP AssociateAddress to Passive's Port1 (new Active)
T+7s:  Route tables updated (private-1a/1b now point to new Active's Port2)
T+10s: Validator confirms reachability → PASSED ✅
```

### 9.6 Verify new Active is operational

Once EIP is reassociated:

```bash
# Ping the new public IP
ping <EIP>

# Or SSH to new Active's MGMT port
ssh -i <key.pem> admin@<NEW_ACTIVE_MGMT_IP>
```

Inside FortiGate:
```
get sys ha status
```

Should now show:
```
This is the ACTIVE unit  ← Changed!
HA Mode: A-P
HA Health Status: OK
```

### 9.7 STOP RECORDING

If recording, stop the screen capture now.

---

## STEP 10: Cleanup

### 10.1 Manual destroy (if not using Watchdog)

```bash
npx cdk destroy --all
```

When prompted: `Are you sure?` → Type `y` and press Enter.

**What gets destroyed:** All EC2 instances, VPC, EIP, IAM roles, etc.

### 10.2 Or let Watchdog auto-destroy (30 min)

The Watchdog stack runs EventBridge → Lambda → CodeBuild to auto-destroy after 30 minutes.

---

## Troubleshooting

### Problem: `No bucket named 'cdk-hnb659fds-assets-...'`

**Cause:** CDK bootstrap S3 bucket doesn't exist. The SSM parameter may exist but the bucket
was deleted. This is the most common first-deploy failure.

**Fix:**
```bash
npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1
```

---

### Problem: `SSM parameter /cdk-bootstrap/hnb659fds/version not found`

**Cause:** CDK environment was never bootstrapped in this account/region.

**Fix:** Same as above — run `cdk bootstrap`.

---

### Problem: `MachineImage not found`

**Cause:** FortiGate AMI not subscribed in Marketplace.

**Fix:**
1. Go to AWS Marketplace → Search "FortiGate-VM64-AWSONDEMAND"
2. Click Subscribe
3. Wait ~1-2 min for subscription to activate
4. Retry `cdk synth`

---

### Problem: `AccessDenied` on IAM actions

**Cause:** User lacks permissions for EC2, VPC, or IAM.

**Fix:**
```bash
aws iam list-attached-user-policies --user-name <username>
```

Attach `AdministratorAccess` or equivalent policies.

---

### Problem: `cdk deploy` hangs or times out

**Cause:** CloudFormation waiting on resource creation (EC2 boot, ENI attachment).

**Fix:**
```bash
# Check CloudFormation stack events
aws cloudformation describe-stack-events \
  --stack-name FortiGateStack \
  --region us-east-1 \
  --query 'StackEvents[0:5]' \
  --output table
```

---

### Problem: Failover doesn't happen (Passive stays Passive after Active termination)

**Cause:** HA heartbeat misconfigured or Port3 ENI not attached.

**Fix:**
1. SSH to surviving instance
2. Check HA status: `get sys ha status`
3. Check Port3 IP: `get sys interface port3`
4. Verify security group allows UDP 703 between subnets

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `infra/cdk.json` | CDK context (adminCidr, haPassword) |
| `infra/lib/network-stack.ts` | VPC, subnets, security groups |
| `infra/lib/fortigate-stack.ts` | EC2 instances, ENIs, UserData (FortiOS config) |
| `infra/lib/watchdog-stack.ts` | EventBridge + Lambda auto-destroy |
| `docs/02-HLD.md` | Architecture overview & failover design |
| `scripts/deploy-and-test.sh` | Full end-to-end deployment + test |

---

## Success Criteria Checklist

- [ ] AWS CLI configured and authenticated (`aws sts get-caller-identity` works)
- [ ] FortiGate PAYG subscripted in Marketplace ("Existing subscription detected")
- [ ] CDK bootstrap S3 bucket exists (`cdk-hnb659fds-assets-<account>-us-east-1`)
- [ ] `npm install` completed in `repo/infra/`
- [ ] `cdk synth -c adminCidr=... -c haPassword=...` succeeds — context via CLI, NOT in cdk.json
- [ ] `cdk deploy --all` completed (infrastructure created)
- [ ] Both EC2 instances (Active/Passive) are **running**
- [ ] EIP is **associated** with Active's Port1
- [ ] Can SSH/HTTPS to Active's Port2 (MGMT)
- [ ] HA status shows "ACTIVE" unit + heartbeat OK
- [ ] Failover test triggered (Active terminated)
- [ ] EIP migrated to Passive's Port1 (detected via `describe-addresses`)
- [ ] New Active is reachable and operational
- [ ] HA status on new Active shows "ACTIVE" unit
- [ ] Cleanup triggered (manual or Watchdog)

---

## Additional Resources

- [High Level Design (HLD)](02-HLD.md)
- [Low Level Design (LLD)](03-LLD.md)
- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
- [FortiGate VM on AWS Guide](https://docs.fortinet.com/product/fortigate/latest/aws)

---

**Last updated:** 2026-06-04  
**Author:** Leonardo Mejía  
**Status:** Ready for production deployment
