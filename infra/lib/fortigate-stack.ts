import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';
import { defaults } from '../config/defaults';

export interface FortiGateStackProps extends cdk.StackProps {
  networkStack: NetworkStack;
}

export class FortiGateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FortiGateStackProps) {
    super(scope, id, props);

    const {
      vpc,
      publicSubnet1a, privateSubnet1a, haSubnet1a,
      publicSubnet1b, privateSubnet1b, haSubnet1b,
      sgWan, sgMgmt, sgHa,
      rtPrivate1a, rtPrivate1b,
    } = props.networkStack;

    const haPassword: string = this.node.tryGetContext('haPassword') ?? 'changeme123';

    // ─── AMI lookup ──────────────────────────────────────────────────────────
    const ami = ec2.MachineImage.lookup({
      name: 'FortiGate-VM64-AWSONDEMAND*',
      owners: ['679593333241'],
    });

    // ─── IAM Role ────────────────────────────────────────────────────────────
    const role = new iam.Role(this, 'FgtRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      inlinePolicies: {
        FgtFailoverPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
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
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // ─── ENIs — FGT-Active (us-east-1a) ──────────────────────────────────────
    const eniP1a = new ec2.CfnNetworkInterface(this, 'EniP1a', {
      subnetId: publicSubnet1a.subnetId,
      groupSet: [sgWan.securityGroupId],
      sourceDestCheck: false,
      description: 'FGT-Active Port1 WAN',
    });

    const eniP2a = new ec2.CfnNetworkInterface(this, 'EniP2a', {
      subnetId: privateSubnet1a.subnetId,
      groupSet: [sgMgmt.securityGroupId],
      sourceDestCheck: false,
      description: 'FGT-Active Port2 MGMT',
    });

    const eniP3a = new ec2.CfnNetworkInterface(this, 'EniP3a', {
      subnetId: haSubnet1a.subnetId,
      groupSet: [sgHa.securityGroupId],
      sourceDestCheck: false,
      description: 'FGT-Active Port3 HA',
    });

    // ─── ENIs — FGT-Passive (us-east-1b) ─────────────────────────────────────
    const eniP1b = new ec2.CfnNetworkInterface(this, 'EniP1b', {
      subnetId: publicSubnet1b.subnetId,
      groupSet: [sgWan.securityGroupId],
      sourceDestCheck: false,
      description: 'FGT-Passive Port1 WAN',
    });

    const eniP2b = new ec2.CfnNetworkInterface(this, 'EniP2b', {
      subnetId: privateSubnet1b.subnetId,
      groupSet: [sgMgmt.securityGroupId],
      sourceDestCheck: false,
      description: 'FGT-Passive Port2 MGMT',
    });

    const eniP3b = new ec2.CfnNetworkInterface(this, 'EniP3b', {
      subnetId: haSubnet1b.subnetId,
      groupSet: [sgHa.securityGroupId],
      sourceDestCheck: false,
      description: 'FGT-Passive Port3 HA',
    });

    // ─── UserData — FGT-Active ────────────────────────────────────────────────
    const rtPrivate1aId = rtPrivate1a.routeTableId;
    const rtPrivate1bId = rtPrivate1b.routeTableId;

    const userDataActive = ec2.UserData.custom(`
config system interface
  edit "port2"
    set allowaccess https ssh
    set alias "MGMT-Port2"
  next
end
config system ha
  set mode a-p
  set group-name "FGT-HA"
  set password "${haPassword}"
  set hbdev "port3" 50
  set session-pickup enable
  set override enable
  set priority ${defaults.haPriorities.active}
  set unicast-hb enable
  set unicast-hb-peerip ${eniP3b.attrPrimaryPrivateIpAddress}
end
config system sdn-connector
  edit "aws"
    set type aws
    set route-table ${rtPrivate1aId},${rtPrivate1bId}
  next
end
`);

    const userDataPassive = ec2.UserData.custom(`
config system interface
  edit "port2"
    set allowaccess https ssh
    set alias "MGMT-Port2"
  next
end
config system ha
  set mode a-p
  set group-name "FGT-HA"
  set password "${haPassword}"
  set hbdev "port3" 50
  set session-pickup enable
  set override enable
  set priority ${defaults.haPriorities.passive}
  set unicast-hb enable
  set unicast-hb-peerip ${eniP3a.attrPrimaryPrivateIpAddress}
end
config system sdn-connector
  edit "aws"
    set type aws
    set route-table ${rtPrivate1aId},${rtPrivate1bId}
  next
end
`);

    // ─── FGT-Active instance ──────────────────────────────────────────────────
    const fgtActive = new ec2.Instance(this, 'FgtActive', {
      instanceType: new ec2.InstanceType(defaults.instanceType),
      machineImage: ami,
      vpc,
      vpcSubnets: { subnets: [publicSubnet1a] },
      securityGroup: sgWan,
      role,
      userData: userDataActive,
      ebsOptimized: true,
      detailedMonitoring: true,
      blockDevices: [{
        deviceName: '/dev/sda1',
        volume: ec2.BlockDeviceVolume.ebs(defaults.ebsGb, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
        }),
      }],
    });

    // Override Port1 to use our pre-created ENI.
    // Must delete SubnetId and SecurityGroupIds — AWS rejects requests that specify
    // both NetworkInterfaces and instance-level subnet/SG (they are mutually exclusive).
    const cfnFgtActive = fgtActive.node.defaultChild as ec2.CfnInstance;
    cfnFgtActive.networkInterfaces = [{
      deviceIndex: '0',
      networkInterfaceId: eniP1a.ref,
    }];
    cfnFgtActive.addPropertyDeletionOverride('SubnetId');
    cfnFgtActive.addPropertyDeletionOverride('SecurityGroupIds');

    new ec2.CfnNetworkInterfaceAttachment(this, 'P2aAttach', {
      instanceId: fgtActive.instanceId,
      networkInterfaceId: eniP2a.ref,
      deviceIndex: '1',
    });

    new ec2.CfnNetworkInterfaceAttachment(this, 'P3aAttach', {
      instanceId: fgtActive.instanceId,
      networkInterfaceId: eniP3a.ref,
      deviceIndex: '2',
    });

    cdk.Tags.of(fgtActive).add('FortigateHACluster', defaults.clusterTag);
    cdk.Tags.of(fgtActive).add('FortigateHARole', 'active');

    // ─── FGT-Passive instance ─────────────────────────────────────────────────
    const fgtPassive = new ec2.Instance(this, 'FgtPassive', {
      instanceType: new ec2.InstanceType(defaults.instanceType),
      machineImage: ami,
      vpc,
      vpcSubnets: { subnets: [publicSubnet1b] },
      securityGroup: sgWan,
      role,
      userData: userDataPassive,
      ebsOptimized: true,
      detailedMonitoring: true,
      blockDevices: [{
        deviceName: '/dev/sda1',
        volume: ec2.BlockDeviceVolume.ebs(defaults.ebsGb, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
        }),
      }],
    });

    const cfnFgtPassive = fgtPassive.node.defaultChild as ec2.CfnInstance;
    cfnFgtPassive.networkInterfaces = [{
      deviceIndex: '0',
      networkInterfaceId: eniP1b.ref,
    }];
    cfnFgtPassive.addPropertyDeletionOverride('SubnetId');
    cfnFgtPassive.addPropertyDeletionOverride('SecurityGroupIds');

    new ec2.CfnNetworkInterfaceAttachment(this, 'P2bAttach', {
      instanceId: fgtPassive.instanceId,
      networkInterfaceId: eniP2b.ref,
      deviceIndex: '1',
    });

    new ec2.CfnNetworkInterfaceAttachment(this, 'P3bAttach', {
      instanceId: fgtPassive.instanceId,
      networkInterfaceId: eniP3b.ref,
      deviceIndex: '2',
    });

    cdk.Tags.of(fgtPassive).add('FortigateHACluster', defaults.clusterTag);
    cdk.Tags.of(fgtPassive).add('FortigateHARole', 'passive');

    // ─── EIP on Port1-A ───────────────────────────────────────────────────────
    const eip = new ec2.CfnEIP(this, 'EipActive', {
      domain: 'vpc',
      tags: [{ key: 'FortigateHACluster', value: defaults.clusterTag }],
    });

    new ec2.CfnEIPAssociation(this, 'EipAssocActive', {
      allocationId: eip.attrAllocationId,
      networkInterfaceId: eniP1a.ref,
    });
  }
}
