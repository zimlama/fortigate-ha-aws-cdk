# Low Level Design — FortiGate HA on AWS

> Prerequisite: read [02-HLD.md](02-HLD.md) for topology and design decisions.
> Diagram: [`docs/diagrams/03-LLD-fortigate-ha.drawio`](diagrams/03-LLD-fortigate-ha.drawio)
> (4 CDK stacks + resources + dependencies — open in [diagrams.net](https://app.diagrams.net)).
> Companion: [06-cdk-preflight-design-checklist.md](06-cdk-preflight-design-checklist.md)
> (design invariants) and [05-troubleshooting-ha-runbook.md](05-troubleshooting-ha-runbook.md).

---

## CDK stack dependencies

```
NetworkStack
    └── FortiGateStack   (imports VPC, subnets, SGs, private route tables)
            └── BastionStack    (imports VPC + sg-mgmt + sg-ha-mgmt; in-VPC validator vantage)
            └── WatchdogStack   (cost guard — auto-destroy)
```

All four stacks deploy in a single `cdk deploy --all` (driven by `deploy-and-test.sh`,
which sets `DEPLOY_VIA_SCRIPT=1`; direct `cdk deploy` is blocked in `bin/app.ts`).

---

## Stack 1 — NetworkStack

### Construct tree

```
NetworkStack
├── VPC (10.0.0.0/16, 2 AZs, no NAT gateway, no default SGs, IGW created manually)
├── Subnet public-1a   (10.0.1.0/24,  AZ a, mapPublicIpOnLaunch: false)  — Port1 WAN
├── Subnet private-1a  (10.0.2.0/24,  AZ a)                              — Port2 data
├── Subnet ha-1a       (10.0.3.0/24,  AZ a)                              — Port3 heartbeat
├── Subnet mgmt-1a     (10.0.4.0/24,  AZ a, public route)               — Port4 HA-MGMT
├── Subnet public-1b   (10.0.11.0/24, AZ b)                             — Port1 WAN
├── Subnet private-1b  (10.0.12.0/24, AZ b)                             — Port2 data
├── Subnet ha-1b       (10.0.13.0/24, AZ b)                             — Port3 heartbeat
├── Subnet mgmt-1b     (10.0.14.0/24, AZ b, public route)               — Port4 HA-MGMT
├── InternetGateway + VPCGatewayAttachment
├── Routes: 0.0.0.0/0 → IGW on public-1a/1b AND mgmt-1a/1b (Port4 needs EC2-API egress)
├── RouteTable private-1a / private-1b  (reused auto-tables; SDN connector ReplaceRoute targets)
├── SecurityGroup sg-wan       (Port1)
├── SecurityGroup sg-mgmt      (Port2)
├── SecurityGroup sg-ha        (Port3)
└── SecurityGroup sg-ha-mgmt   (Port4)
```

> 8 subnets, 4 per AZ — this is the Fortinet cross-AZ reference layout (WAN / data /
> heartbeat / dedicated HA-management). See [04-fortinet-ha-reference-design.md](04-fortinet-ha-reference-design.md).

### Security group rules

**sg-wan** (Port1 — public WAN):
```
Inbound:  TCP 443  0.0.0.0/0   HTTPS management / SSL-VPN
          UDP 500  0.0.0.0/0   IKEv2 Phase 1
          UDP 4500 0.0.0.0/0   IKEv2 NAT-T
          ICMP -1  0.0.0.0/0   Health probes
Outbound: All      0.0.0.0/0
```

**sg-mgmt** (Port2 — admin, RFC-001):
```
Inbound:  TCP 443  { adminCidr }   HTTPS GUI (CDK context var, never hardcoded)
          TCP 22   { adminCidr }   SSH CLI
Outbound: All      0.0.0.0/0
```

**sg-ha** (Port3 — FGCP heartbeat + session sync, intra-cluster):
```
Inbound:  ALL traffic   source = sg-ha (self-referencing)   between cluster members
Outbound: All           0.0.0.0/0
```
> ⚠️ **Do NOT scope this to TCP/UDP 703.** 703 is session-sync; the FGCP heartbeat
> uses protocol-level packets (EtherType 0x8890/0x8891/0x8893, encapsulated for unicast).
> A port-scoped rule silently drops the heartbeat → the cluster never forms
> (`number of member: 1`) → no failover. This was the project's root-cause bug
> (lesson #8 / runbook §4.A). The self-referencing allow-all keeps it open only
> between the two Port3 ENIs (both in sg-ha) and closed to everything else.

**sg-ha-mgmt** (Port4 — dedicated HA-management):
```
Inbound:  TCP 443  { adminCidr }   HTTPS GUI
          TCP 22   { adminCidr }   SSH CLI
          ICMP -1  { adminCidr }   Reachability probes
Outbound: All      0.0.0.0/0        (EC2 API egress for the SDN connector)
```
> Bastion → Port4 (22) and Port2 (22/443) ingress rules are added in **BastionStack**
> (as standalone `CfnSecurityGroupIngress`) to keep the dependency one-way and avoid a cycle.

### CDK outputs

```typescript
new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
new CfnOutput(this, 'PrivateRouteTable1aId', { value: rtPrivate1a.routeTableId });
new CfnOutput(this, 'PrivateRouteTable1bId', { value: rtPrivate1b.routeTableId });
```

---

## Stack 2 — FortiGateStack

### AMI lookup

```typescript
const ami = ec2.MachineImage.lookup({
  name: 'FortiGate-VM64-AWSONDEMAND*',
  owners: ['679593333241'],   // Fortinet AWS Marketplace owner
});
```
Dynamic — resolves the latest AMI in the target region (lesson #3). Pin with a
narrower `name` filter (e.g. `…AWSONDEMAND-7.6.*`) if a fixed FortiOS version is required.

### ENI layout (8 total, 4 per instance)

```
FGT-Active (us-east-1a)            FGT-Passive (us-east-1b)
  eni-p1a  public-1a   Port1 WAN     eni-p1b  public-1b   Port1 WAN
  eni-p2a  private-1a  Port2 data    eni-p2b  private-1b  Port2 data
  eni-p3a  ha-1a       Port3 HB      eni-p3b  ha-1b       Port3 HB
  eni-p4a  mgmt-1a     Port4 MGMT    eni-p4b  mgmt-1b     Port4 MGMT
```

- All ENIs: `sourceDestCheck: false` (FortiGate routes third-party IPs — lesson #2).
- SG assignment: Port1 → sg-wan, Port2 → sg-mgmt, Port3 → sg-ha, Port4 → sg-ha-mgmt.
- **All 4 ENIs attached AT LAUNCH** via the instance's `networkInterfaces` array, not
  post-boot. Sequential `CfnNetworkInterfaceAttachment` would let UserData run before
  Ports 2/3/4 exist, silently breaking HA + the SDN connector (lesson #3 area / checklist B3):

```typescript
const cfn = fgtActive.node.defaultChild as ec2.CfnInstance;
cfn.networkInterfaces = [
  { deviceIndex: '0', networkInterfaceId: eniP1a.ref },
  { deviceIndex: '1', networkInterfaceId: eniP2a.ref },
  { deviceIndex: '2', networkInterfaceId: eniP3a.ref },
  { deviceIndex: '3', networkInterfaceId: eniP4a.ref },
];
cfn.addPropertyDeletionOverride('SubnetId');
cfn.addPropertyDeletionOverride('SecurityGroupIds');
```

### EIPs (1 cluster + 2 per-unit mgmt)

```
EipActive   → eni-p1a (Port1)   tag FortigateHACluster=fortigate-ha   ← the cluster VIP, fails over
EipMgmtA    → eni-p4a (Port4)   tag FortigateHARole=active-mgmt        ← per-unit, does NOT fail over
EipMgmtB    → eni-p4b (Port4)   tag FortigateHARole=passive-mgmt       ← per-unit, does NOT fail over
```

> The validator finds the active node by **who holds the `FortigateHACluster`-tagged
> EIP**. Only the cluster VIP carries that tag; the mgmt EIPs must NOT, or active
> detection breaks (checklist G1/G2). On failover the FGCP callback runs
> `ec2:DisassociateAddress` (release from the terminated unit's eni-p1a) then
> `ec2:AssociateAddress` (attach to eni-p1b).

### IAM instance profile

```typescript
const role = new iam.Role(this, 'FgtRole', {
  assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
  inlinePolicies: {
    FgtFailoverPolicy: new iam.PolicyDocument({
      statements: [new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:Describe*',              // all discovery calls the SDN connector needs
          'ec2:AssociateAddress',
          'ec2:DisassociateAddress',    // required: release EIP from terminated unit's ENI first
          'ec2:AssignPrivateIpAddresses',
          'ec2:UnassignPrivateIpAddresses',
          'ec2:ReplaceRoute',
        ],
        resources: ['*'],  // EC2 describe/associate don't support resource-level restriction
      })],
    }),
  },
});
```
> IAM only matters AFTER the cluster forms and failover fires. If the cluster is
> 1-member, fix sg-ha first — IAM is a red herring until then (lesson #9).

### UserData (bootstrap config)

Injected via `ec2.UserData.custom(...)`. Per unit (priorities/gateway/peer differ):

1. **Admin password** — set explicitly, else default = instance-id and first login
   forces a change, blocking automation (lesson #10):
```
config system admin
  edit "admin"
    set password "{{ ha_password }}"
  next
end
```

2. **Interface access** — Port2 (data/admin) and Port4 (HA-MGMT):
```
config system interface
  edit "port2"
    set allowaccess https ssh
    set alias "MGMT-Port2"
  next
  edit "port4"
    set allowaccess https ssh ping
    set alias "HA-MGMT"
  next
end
```

3. **HA — unicast A-P with dedicated mgmt interface** (no L2/multicast in AWS):
```
config system ha
  set mode a-p
  set group-name "FGT-HA"
  set password "{{ ha_password }}"
  set hbdev "port3" 50
  set session-pickup enable
  set ha-mgmt-status enable
  config ha-mgmt-interfaces
    edit 1
      set interface "port4"
      set gateway {{ mgmt_gw }}        # .1 of the unit's mgmt subnet
    next
  end
  set override enable
  set priority {{ priority }}          # 200 Active, 100 Passive
  set unicast-hb enable
  set unicast-hb-peerip {{ peer_p3_ip }}
end
```

4. **SDN connector** — both AZ route tables so failover updates both (lesson #7):
```
config system sdn-connector
  edit "aws"
    set type aws
    set use-metadata-iam enable
    set ha-status enable
    set route-table {{ rtPrivate1aId }},{{ rtPrivate1bId }}
  next
end
```

### CDK outputs

```typescript
FgtActivePort2Ip / FgtPassivePort2Ip   // data interface (bastion SSH fallback)
FgtActivePort4Ip / FgtPassivePort4Ip   // HA-MGMT — reliable SSH path for diagnostics
```

---

## Stack 3 — BastionStack

In-VPC, SSM-managed vantage point (no SSH key, no inbound SG). Purposes:

1. Run the failover **validator** (must reach the active node's Port2 PRIVATE IP).
2. Run **SSH diagnostics** against the FortiGates (Port4 / Port2) — `ha-test.sh`.

```
BastionStack
├── S3 ValidatorBucket          (validator.tgz staged here, autoDelete)
├── SecurityGroup sg-bastion    (no ingress; allowAllOutbound)
├── Ingress BastionToPort2      (sg-mgmt    : 443 from sg-bastion)
├── Ingress BastionToPort2Ssh   (sg-mgmt    : 22  from sg-bastion)
├── Ingress BastionToPort4Ssh   (sg-ha-mgmt : 22  from sg-bastion)   ← reliable diag path
├── IAM role (AmazonSSMManagedInstanceCore + ec2:DescribeInstances/Addresses + S3 read)
├── Instance (t3.micro, Amazon Linux 2023; UserData: dnf install nodejs tar)
└── BastionEip                  (egress for EC2 API / S3 / SSM)
Outputs: BastionInstanceId, ValidatorBucketName
```

---

## Stack 4 — WatchdogStack

Cost guard — auto-destroys all stacks at the lab timeout, independent of the local
`deploy-and-test.sh` cleanup trap (defence in depth against runaway cost).

```typescript
const rule = new events.Rule(this, 'AutoDestroyRule', {
  schedule: events.Schedule.rate(cdk.Duration.minutes(30)),   // defaults.labTimeoutMinutes
});
// → Lambda (Python) → CodeBuild project running `cdk destroy --all --force --ci`
```
CodeBuild role needs `cloudformation:*`, `ec2:*`, `iam:*` scoped to the FortiGate stacks.

---

## CDK fine-grained assertion tests (`infra/test/`)

Key assertions (verified without deploying) — keep these in sync with the design above:

```typescript
// 8 ENIs, all with sourceDestCheck: false
template.resourceCountIs('AWS::EC2::NetworkInterface', 8);
template.allResourcesProperties('AWS::EC2::NetworkInterface', { SourceDestCheck: false });

// FgtRole failover actions
template.hasResourceProperties('AWS::IAM::Policy', {
  PolicyDocument: Match.objectLike({
    Statement: Match.arrayWith([ Match.objectLike({ Action: Match.arrayWith([
      'ec2:Describe*', 'ec2:AssociateAddress', 'ec2:DisassociateAddress',
      'ec2:ReplaceRoute',
    ])})]),
  }),
});

// sg-ha is self-referencing allow-all (NOT port 703)
template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
  IpProtocol: '-1',  // all protocols, source = sg-ha itself
});

// EventBridge watchdog fires every 30 min
template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(30 minutes)' });
```

> If you change the design, update these assertions AND the
> [pre-flight checklist](06-cdk-preflight-design-checklist.md).

---

## Configuration reference (`infra/config/defaults.ts`)

```typescript
export const defaults = {
  vpcCidr:        '10.0.0.0/16',
  subnets: {
    publicA: '10.0.1.0/24',  privateA: '10.0.2.0/24',
    haA:     '10.0.3.0/24',  mgmtA:    '10.0.4.0/24',
    publicB: '10.0.11.0/24', privateB: '10.0.12.0/24',
    haB:     '10.0.13.0/24', mgmtB:    '10.0.14.0/24',
  },
  instanceType:        'c6in.xlarge',
  bastionInstanceType: 't3.micro',
  clusterTag:          'fortigate-ha',
  ebsGb:               30,
  haPriorities:        { active: 200, passive: 100 },
  haPort:              703,   // session-sync reference only — NOT used to scope sg-ha
  failoverTimeout:     120,   // seconds (NFR)
  labTimeoutMinutes:   30,    // watchdog
  lambdaTimeoutSeconds: 30,
} as const;
```

All timing and sizing values come from here — zero magic numbers in stack code.

---

## Deploy & test pre-requisites

1. **Accept FortiGate PAYG terms** in AWS Console → Marketplace → FortiGate-VM64-AWSONDEMAND.
   Without this, instances launch then terminate with no CFN error (lesson #6).
2. **Run via the script** (never raw `cdk deploy`):
   ```bash
   HA_PASSWORD='<pw>' AWS_PROFILE=default ./scripts/deploy-and-test.sh
   ```
   It builds/stages the validator, deploys all stacks, waits `HA_BOOT_WAIT` for HA to
   form, runs `ha-test.sh` (pre-flight gate → failover → diagnostics), then auto-destroys.
   Full run log is tee'd to `/tmp/fgt-ha-run-<ts>.log`.
3. `adminCidr` / `haPassword` are passed as CDK context — never hardcoded.
