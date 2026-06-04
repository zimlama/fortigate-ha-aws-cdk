---
title: Session Context - AWS FortiGate HA Demo Preparation
date: 2026-06-04
session: Leonardo's Session (Continuation)
---

# 📋 Session Context & Progress

**Date:** 2026-06-04  
**Objective:** Prepare FortiGate HA cluster on AWS for failover demo  
**Status:** ✅ **READY FOR DEPLOYMENT**

---

## ✅ Completed in This Session

### 1. AWS Environment Validation
- **AWS CLI:** v2.34.58 ✅
- **AWS Account:** 064625181580 ✅
- **IAM User:** leonardo.admin.aws ✅
- **IAM Group:** admin.aws (AdministratorAccess) ✅
- **Region:** us-east-1 ✅
- **Credentials:** Configured & active ✅

### 2. FortiGate AMI Subscription
- **Product:** Fortinet FortiGate VM Next-Generation Firewall Deployed on AWS
- **Offer ID:** 2wqkpek696qhdeo7lbbjncqli
- **Agreement ID:** agmt-bfdlpjpywqexqaztgfv9who2o
- **Status:** ✅ Active
- **Pricing:** Usage-based (PAYG)
- **Free Trial:** 30 days (included)

### 3. CDK Configuration
**File Updated:** `infra/cdk.json`

```json
{
  "app": "npx ts-node --prefer-ts-exts bin/app.ts",
  "context": {
    "@aws-cdk/aws-lambda:recognizeLayerVersion": true,
    "@aws-cdk/core:checkSecretUsage": true,
    "@aws-cdk/core:target-partitions": ["aws", "aws-cn"],
    "adminCidr": "0.0.0.0/0",
    "haPassword": "FortiGate123!"
  }
}
```

**Parameters:**
- `adminCidr`: `0.0.0.0/0` (lab mode; change for prod)
- `haPassword`: `FortiGate123!` (change for prod)

### 4. Dependencies Installed
```bash
npm install
# Result: added 1 package, audited 339 packages ✅
```

**Key packages:**
- aws-cdk-lib@2.257.0
- aws-cdk@2.1126.0
- typescript@5.9.3
- ts-node@10.9.2
- constructs@10.6.0

### 5. CDK Synthesis Validated
```bash
npx cdk synth
# Result: Successfully synthesized to /path/to/cdk.out ✅
```

- AMI lookup: ✅ Found FortiGate-VM64-AWSONDEMAND
- CloudFormation templates: ✅ Generated
- Configuration: ✅ Valid

### 6. Documentation Created
- **File:** `docs/03-DEPLOYMENT-GUIDE.md` (576 lines)
- **Content:** Complete step-by-step guide from AWS CLI validation to failover test
- **Status:** ✅ Uploaded to GitHub

---

## 🎯 Next Steps (In Your Other Session)

### IMMEDIATE (Ready Now)

1. **Navigate to repo:**
   ```bash
   cd /Users/leonardomejia/projects/obsidian/Folio/40_proyectos/fortigate-ha-aws-cdk/repo/infra
   ```

2. **Deploy infrastructure:**
   ```bash
   npx cdk deploy --all
   ```
   - Duration: ~5-10 minutes
   - Creates: VPC, EC2 instances (2×), ENIs (6), EIP, security groups, IAM roles

3. **Monitor deployment:**
   ```bash
   aws cloudformation describe-stacks --region us-east-1 --output table
   ```

4. **Verify both instances running:**
   ```bash
   aws ec2 describe-instances \
     --region us-east-1 \
     --filters "Name=tag:FortigateHACluster,Values=fgt-ha-demo" \
     --output table
   ```

### DEMO (When Ready to Test Failover)

1. **Start recording** (QuickTime or OBS)

2. **Verify initial state:**
   ```bash
   aws ec2 describe-addresses --region us-east-1 --output table
   ```

3. **Terminate FGT-Active** (trigger failover):
   ```bash
   aws ec2 terminate-instances \
     --instance-ids i-xxxxxxxxx \
     --region us-east-1
   ```

4. **Monitor in real-time (2 terminals):**
   
   **Terminal 1 - Instance state:**
   ```bash
   watch -n 2 'aws ec2 describe-instances \
     --region us-east-1 \
     --filters "Name=tag:FortigateHACluster,Values=fgt-ha-demo" \
     --output table'
   ```

   **Terminal 2 - EIP migration:**
   ```bash
   watch -n 2 'aws ec2 describe-addresses \
     --region us-east-1 \
     --filters "Name=tag:FortigateHACluster,Values=fgt-ha-demo" \
     --output table'
   ```

5. **Expected failover sequence:**
   - T+0s: Active instance terminates
   - T+3s: Passive detects heartbeat loss
   - T+5-7s: EIP migrates to Passive's Port1
   - T+7s: Route tables update (private subnet routes → new Active's Port2)
   - T+10s: Validator confirms reachability ✅

6. **Verify new Active is operational:**
   ```bash
   ssh -i <key.pem> admin@<NEW_ACTIVE_MGMT_IP>
   # Inside FortiGate:
   get sys ha status
   # Should show: "This is the ACTIVE unit"
   ```

7. **Stop recording**

### CLEANUP

Either:
- **Manual:** `npx cdk destroy --all`
- **Automatic:** Watchdog Lambda auto-destroys after 30 min

---

## 📚 Key Resources

| File | Purpose |
|------|---------|
| `docs/03-DEPLOYMENT-GUIDE.md` | Complete step-by-step deployment guide |
| `docs/02-HLD.md` | Architecture overview & failover design |
| `infra/cdk.json` | CDK context (updated ✅) |
| `infra/lib/fortigate-stack.ts` | EC2 instances, ENIs, UserData (FortiOS config) |
| `infra/lib/network-stack.ts` | VPC, subnets, security groups |
| `infra/lib/watchdog-stack.ts` | Auto-destroy after 30 min |

---

## 🔧 Important Details

### FortiGate Configuration (Applied via UserData)

**Both instances receive:**
```bash
config system interface
  edit "port2"
    set allowaccess https ssh
    set alias "MGMT-Port2"
  next
end

config system ha
  set mode a-p
  set group-name "FGT-HA"
  set password "FortiGate123!"
  set hbdev "port3" 50
  set session-pickup enable
  set override enable
  set priority <200|100>  # 200=Active, 100=Passive
  set unicast-hb enable
  set unicast-hb-peerip <peer-port3-ip>
end

config system sdn-connector
  edit "aws"
    set type aws
    set route-table <rtPrivate1aId>,<rtPrivate1bId>
  next
end
```

### AWS API Failover (Automatic on HA election)

When Passive becomes Active, FortiOS calls:
1. `ec2:DisassociateAddress` → Remove EIP from old Active's Port1
2. `ec2:AssociateAddress` → Attach EIP to new Active's Port1
3. `ec2:ReplaceRoute` (×2) → Update private-1a & private-1b route tables

**Result:** All traffic (public WAN via EIP + management via Port2) follows the new Active instantly.

---

## ⚠️ Important Notes

1. **Default credentials are OPEN** (`adminCidr: 0.0.0.0/0`)
   - Change to your IP in production: `"adminCidr": "YOUR_IP/32"`

2. **HA password is hardcoded** (`haPassword: "FortiGate123!"`)
   - Change in production via cdk.json or AWS Secrets Manager

3. **Watchdog will destroy after 30 min** (safety mechanism)
   - Manual cleanup: `cdk destroy --all`

4. **This is a lab/demo setup**, not production-ready
   - For production: use BYOL licensing, proper secrets management, restricted admin CIDR

---

## 📝 Git Status

**Last commit:**
```
19ace23 docs: add comprehensive deployment & failover test guide
cfd6da8 fix(docs): correct image path in Topology overview
00440f5 docs: add FortiGate HA topology diagram PNG
e64c2d1 docs: replace ASCII topology diagram with PNG image in Topology overview
```

**All files pushed to GitHub** ✅

---

## 🎯 Success Criteria (To Verify After Deploy)

- [ ] Both EC2 instances running (Active + Passive)
- [ ] EIP associated with Active's Port1
- [ ] Can SSH to Active's Port2 (MGMT)
- [ ] HA status shows "ACTIVE unit" + heartbeat OK
- [ ] Failover triggered (Active terminated)
- [ ] EIP migrated to Passive's Port1 (< 10 sec)
- [ ] Route tables updated (private subnets now point to new Active's Port2)
- [ ] New Active is reachable and operational
- [ ] HA status on new Active shows "ACTIVE unit"

---

## Questions?

Refer to:
1. **How to deploy?** → `docs/03-DEPLOYMENT-GUIDE.md` § STEP 6
2. **What's the architecture?** → `docs/02-HLD.md`
3. **Troubleshooting?** → `docs/03-DEPLOYMENT-GUIDE.md` § Troubleshooting

---

**Created:** 2026-06-04 16:45 UTC  
**Author:** Leonardo Mejía  
**Status:** Ready for continuation in other session ✅
