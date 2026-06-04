# Low Level Design — FortiGate HA on AWS

> Prerequisite: read [02-HLD.md](02-HLD.md) for topology and design decisions.

---

## CDK stack dependencies

```
NetworkStack
    └── FortiGateStack   (imports VPC, subnets, SGs)
            └── WatchdogStack  (imports stack names for destroy target)
```

All three stacks are synthesised and deployed in a single `cdk deploy --all`.

---

## Stack 1 — NetworkStack

### Construct tree

```
NetworkStack
├── VPC (10.0.0.0/16, 2 AZs, no NAT gateway, no default SGs)
├── Subnet public-1a   (10.0.1.0/24,  AZ us-east-1a, mapPublicIpOnLaunch: false)
├── Subnet private-1a  (10.0.2.0/24,  AZ us-east-1a)
├── Subnet ha-1a       (10.0.3.0/24,  AZ us-east-1a)
├── Subnet public-1b   (10.0.11.0/24, AZ us-east-1b, mapPublicIpOnLaunch: false)
├── Subnet private-1b  (10.0.12.0/24, AZ us-east-1b)
├── Subnet ha-1b       (10.0.13.0/24, AZ us-east-1b)
├── InternetGateway + VPCGatewayAttachment
├── RouteTable public  (0.0.0.0/0 → IGW; associated to public-1a + public-1b)
├── RouteTable private-1a  (0.0.0.0/0 → Port2-A ENI; updated on failover)
├── RouteTable private-1b  (0.0.0.0/0 → Port2-A ENI initially; updated on failover)
├── SecurityGroup sg-wan
├── SecurityGroup sg-mgmt
└── SecurityGroup sg-ha
```

### Security group rules

**sg-wan** (Port1 — public WAN):
```
Inbound:  TCP 443    0.0.0.0/0      HTTPS management / SSL-VPN
          UDP 500    0.0.0.0/0      IKEv2 Phase 1
          UDP 4500   0.0.0.0/0      IKEv2 NAT-T
          ICMP -1    0.0.0.0/0      Health probes
Outbound: All        0.0.0.0/0
```

**sg-mgmt** (Port2 — admin, RFC-001):
```
Inbound:  TCP 443   { adminCidr }   HTTPS GUI (CDK context var, never hardcoded)
          TCP 22    { adminCidr }   SSH CLI
Outbound: All       0.0.0.0/0
```

**sg-ha** (Port3 — heartbeat only):
```
Inbound:  TCP 703   10.0.0.0/16    FGCP heartbeat
          UDP 703   10.0.0.0/16    FGCP heartbeat
Outbound: TCP 703   10.0.0.0/16
          UDP 703   10.0.0.0/16
```

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

Lookup is dynamic — always resolves to the latest available AMI in the target region.
Pin to a specific version by adding `filters: { 'name': ['FortiGate-VM64-AWSONDEMAND-7.6.*'] }`.

### ENI layout (6 total, 3 per instance)

```
FGT-Active (us-east-1a)          FGT-Passive (us-east-1b)
  eni-p1a  subnet: public-1a       eni-p1b  subnet: public-1b
  eni-p2a  subnet: private-1a      eni-p2b  subnet: private-1b
  eni-p3a  subnet: ha-1a           eni-p3b  subnet: ha-1b
```

All ENIs: `sourceDestCheck: false` (required for FortiGate to route traffic).
SG assignments: Port1 → sg-wan, Port2 → sg-mgmt, Port3 → sg-ha.

### EIP

One EIP attached to `eni-p1a` at deploy time. On failover FortiGate calls:
1. `ec2:DisassociateAddress` — detach from eni-p1a
2. `ec2:AssociateAddress` — attach to eni-p1b

### IAM instance profile

```typescript
const role = new iam.Role(this, 'FgtRole', {
  assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
  inlinePolicies: {
    FgtFailoverPolicy: new iam.PolicyDocument({
      statements: [new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:AssociateAddress',
          'ec2:DisassociateAddress',
          'ec2:DescribeAddresses',
          'ec2:DescribeInstances',
          'ec2:DescribeInstanceStatus',
          'ec2:DescribeNetworkInterfaces',
          'ec2:ReplaceRoute',
        ],
        resources: ['*'],  // EC2 describe/associate don't support resource-level restriction
      })],
    }),
  },
});
```

### UserData (bootstrap config)

Injected via `ec2.UserData.custom(...)`. Configures:

1. **Port2 admin access** (RFC-001 — the thesis):
```
config system interface
  edit "port2"
    set allowaccess https ssh
    set alias "MGMT-Port2"
  next
end
```

2. **HA unicast** (mandatory in AWS — no L2/multicast):
```
config system ha
  set mode a-p
  set group-name "FGT-HA"
  set password "{{ ha_password }}"
  set hbdev "port3" 50
  set session-pickup enable
  set override enable
  set priority {{ priority }}           # 200 for Active, 100 for Passive
  set unicast-hb enable
  set unicast-hb-peerip {{ peer_p3_ip }}
end
```

3. **Route table IDs** passed as CDK context vars so the FortiGate callback knows which
   route tables to update on failover:
```
config system sdn-connector
  edit "aws"
    set type aws
    set route-table {{ rtPrivate1aId }},{{ rtPrivate1bId }}
  next
end
```

### Instance construct

```typescript
const fgt = new ec2.Instance(this, 'FgtActive', {
  instanceType: new ec2.InstanceType('c6in.xlarge'),
  machineImage: ami,
  vpc,
  vpcSubnets: { subnets: [publicSubnet1a] },   // primary ENI = Port1
  securityGroup: sgWan,
  role,
  userData,
  blockDevices: [{
    deviceName: '/dev/sda1',
    volume: ec2.BlockDeviceVolume.ebs(30, { volumeType: ec2.EbsDeviceVolumeType.GP3 }),
  }],
});
// Attach Port2 and Port3 as additional ENIs
new ec2.CfnNetworkInterfaceAttachment(this, 'P2aAttach', {
  instanceId: fgt.instanceId, networkInterfaceId: eniP2a.ref, deviceIndex: '1',
});
new ec2.CfnNetworkInterfaceAttachment(this, 'P3aAttach', {
  instanceId: fgt.instanceId, networkInterfaceId: eniP3a.ref, deviceIndex: '2',
});
```

---

## Stack 3 — WatchdogStack

### EventBridge rule

```typescript
const rule = new events.Rule(this, 'AutoDestroyRule', {
  schedule: events.Schedule.rate(cdk.Duration.minutes(30)),
});
```

### Lambda (trigger)

Invokes a CodeBuild project. Uses Lambda over direct CodeBuild invocation to allow
environment variable injection (stack names, region) at runtime.

```typescript
const fn = new lambda.Function(this, 'WatchdogFn', {
  runtime: lambda.Runtime.PYTHON_3_12,
  handler: 'index.handler',
  code: lambda.Code.fromInline(`
import boto3, os
def handler(event, context):
    cb = boto3.client('codebuild')
    cb.start_build(projectName=os.environ['CODEBUILD_PROJECT'])
`),
  environment: { CODEBUILD_PROJECT: destroyProject.projectName },
  timeout: cdk.Duration.seconds(30),
});
rule.addTarget(new targets.LambdaFunction(fn));
```

### CodeBuild project (destroy)

```typescript
const destroyProject = new codebuild.Project(this, 'DestroyProject', {
  buildSpec: codebuild.BuildSpec.fromObject({
    version: '0.2',
    phases: {
      install: { commands: ['npm ci'] },
      build:   { commands: ['npx cdk destroy --all --force --ci'] },
    },
  }),
  environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
});
```

CodeBuild role needs `cloudformation:*`, `ec2:*`, `iam:*` scoped to the FortiGate stacks.

---

## CDK fine-grained assertion tests (`infra/test/`)

Key assertions (verified without deploying):

```typescript
// 6 ENIs with sourceDestCheck: false
template.resourceCountIs('AWS::EC2::NetworkInterface', 6);
template.allResourcesProperties('AWS::EC2::NetworkInterface', {
  SourceDestCheck: false,
});

// IAM role has exactly 7 actions
template.hasResourceProperties('AWS::IAM::Policy', {
  PolicyDocument: Match.objectLike({
    Statement: [{ Action: Match.arrayWith([
      'ec2:AssociateAddress', 'ec2:DisassociateAddress',
      'ec2:DescribeAddresses', 'ec2:DescribeInstances',
      'ec2:DescribeInstanceStatus', 'ec2:DescribeNetworkInterfaces',
      'ec2:ReplaceRoute',
    ])}],
  }),
});

// HA SG allows port 703 within VPC only
template.hasResourceProperties('AWS::EC2::SecurityGroup', {
  SecurityGroupIngress: Match.arrayWith([
    Match.objectLike({ IpProtocol: 'tcp', FromPort: 703, ToPort: 703, CidrIp: '10.0.0.0/16' }),
  ]),
});

// EventBridge rule fires every 30 min
template.hasResourceProperties('AWS::Events::Rule', {
  ScheduleExpression: 'rate(30 minutes)',
});
```

---

## Configuration reference (`infra/config/defaults.ts`)

```typescript
export const defaults = {
  vpcCidr:        '10.0.0.0/16',
  subnets: {
    publicA:      '10.0.1.0/24',
    privateA:     '10.0.2.0/24',
    haA:          '10.0.3.0/24',
    publicB:      '10.0.11.0/24',
    privateB:     '10.0.12.0/24',
    haB:          '10.0.13.0/24',
  },
  instanceType:   'c6in.xlarge',
  ebsGb:          30,
  haPriorities:   { active: 200, passive: 100 },
  haPort:         703,
  failoverTimeout: 120,  // seconds (NFR)
  labTimeout:     30,    // minutes (watchdog)
} as const;
```

All timing and sizing values come from here — zero magic numbers in stack code.

---

## Deploy pre-requisites

1. **Accept FortiGate PAYG terms** in AWS Console → Marketplace → FortiGate-VM64-AWSONDEMAND.
   Without this, `cdk deploy` fails at EC2 launch.
2. **Set CDK context vars** (never hardcode):
   ```bash
   npx cdk deploy --all \
     -c adminCidr=YOUR.IP.HERE/32 \
     -c haPassword=changeme123
   ```
3. AWS profile: `test-admin` (us-east-1).
