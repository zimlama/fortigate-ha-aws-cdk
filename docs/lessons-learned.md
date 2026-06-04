# Lessons Learned

> Format: **Symptom → Tried → Worked → Why**
> Ordered by impact — the most costly mistakes first.

---

## 1. FortiGate MGMT interface does not fail over in AWS — use Port2 for admin access

**Symptom:** After failover, the new Active FortiGate is unreachable via HTTPS/SSH. The old Active IP is gone (instance terminated), and the new Active's MGMT interface has a different IP that was never made accessible.

**Tried:** Connecting to the MGMT IP of the new Active after failover. Timeout — the MGMT interface is not covered by the FGCP callback.

**Worked:** Configure `set allowaccess https ssh` on `port2` (INTERNAL). Port2 is a private ENI whose subnet route table is updated by the FGCP callback (`ec2:ReplaceRoute`). Management follows the Active node automatically.

**Why:** The FGCP failover callback in AWS performs exactly two API operations: `ec2:AssociateAddress` (EIP to new Port1) and `ec2:ReplaceRoute` (private route tables to new Port2). MGMT is not in scope for either operation. This is by design — FortiOS expects MGMT to be on a dedicated out-of-band network. In AWS, that assumption breaks.

---

## 2. `sourceDestCheck: false` is required on ALL ENIs, not just WAN

**Symptom:** Routing works for internet-bound traffic but fails for cross-ENI forwarding between subnets.

**Tried:** Setting `sourceDestCheck: false` only on Port1 (WAN) because that's the "router interface."

**Worked:** Setting `sourceDestCheck: false` on all 6 ENIs (Port1, Port2, Port3 × 2 instances).

**Why:** AWS's source/destination check validates that the packet's source or destination matches the ENI's IP. A FortiGate is a router — it legitimately forwards packets with third-party IPs on every interface, including the management (Port2) and heartbeat (Port3) ENIs. The check must be disabled on all of them.

---

## 3. AMI IDs change per region, per FortiOS version, and over time — use dynamic lookup

**Symptom:** CDK deploy fails with `InvalidAMIID.NotFound` when run in a different region or after a FortiOS version update.

**Tried:** Hardcoding the AMI ID found in the console at the time of writing.

**Worked:**
```typescript
ec2.MachineImage.lookup({
  name: 'FortiGate-VM64-AWSONDEMAND*',
  owners: ['679593333241'],
})
```

**Why:** Fortinet publishes new AMIs for each FortiOS minor release. The AMI ID is region-specific and changes without notice. Dynamic lookup resolves the latest AMI at synth time — the IaC never goes stale.

---

## 4. FGCP HA must use unicast in AWS — multicast is not available

**Symptom:** FortiGate HA heartbeat never establishes. Both nodes remain in ACTIVE state (split-brain).

**Tried:** Default FGCP configuration, which uses multicast for heartbeat discovery.

**Worked:**
```
config system ha
  set unicast-hb enable
  set unicast-hb-peerip <peer-port3-private-ip>
end
```

**Why:** AWS VPC does not support multicast. FGCP's default heartbeat mechanism (multicast on port 703) silently fails — neither node sees the other, so both stay Active. Unicast mode requires the peer's explicit IP, which is why the CDK stack uses `eniP3b.attrPrimaryPrivateIpAddress` to inject the peer IP into the UserData at deploy time.

---

## 5. IAM role goes on the Instance Profile, not directly on the instance

**Symptom:** `cdk synth` succeeds but `cdk deploy` fails with `InvalidParameterValue: Invalid IAM Instance Profile`.

**Tried:** Passing the IAM Role ARN directly as `IamInstanceProfile` in the EC2 resource.

**Worked:** Creating an `AWS::IAM::InstanceProfile` wrapping the role and referencing the profile — which CDK's `ec2.Instance` handles automatically via `role:` prop.

**Why:** EC2 does not accept an IAM Role ARN directly. It requires an Instance Profile — a container resource that wraps the role and is what EC2 actually attaches. CDK abstracts this, but raw CloudFormation and some CDK escape hatches require it explicitly.

---

## 6. FortiGate PAYG Marketplace terms must be accepted before the first deploy — and it blocks silently

**Symptom:** `cdk deploy` completes successfully (CloudFormation stack reaches `CREATE_COMPLETE`) but EC2 instances never reach `running`. They stay in `pending` and then move to `terminated`.

**Tried:** Checking CloudFormation events — no errors. Checking EC2 console — instances terminate immediately.

**Worked:** Accepting the FortiGate PAYG subscription in the AWS Marketplace console for the account.

**Why:** AWS Marketplace PAYG AMIs silently refuse to launch if the account has not accepted the subscription terms. CloudFormation considers the `RunInstances` API call successful (the call itself does not fail), but the instance is immediately terminated by the Marketplace enforcement mechanism. There is no CloudFormation event or error — you have to know to check the Marketplace subscription status.

---

## 7. Cross-AZ HA adds a second route table update — both AZs must be covered

**Symptom:** After failover, traffic from AZ-b reaches the Passive (now Active) FortiGate via Port2-B correctly. But traffic from AZ-a still routes to the old Port2-A (terminated instance).

**Tried:** Updating only the route table of the AZ where the new Active lives.

**Worked:** Configuring the SDN connector with both private route table IDs:
```
config system sdn-connector
  edit "aws"
    set route-table <rtPrivate1aId>,<rtPrivate1bId>
  next
end
```

**Why:** In a 2-AZ design, each AZ has its own private route table. Both tables have a `0.0.0.0/0` route pointing to Port2 of the Active FortiGate. When failover occurs, the FGCP callback must update both route tables — otherwise the AZ where the old Active lived keeps routing to a terminated ENI. The SDN connector takes a comma-separated list of route table IDs.
