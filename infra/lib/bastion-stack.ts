import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';
import { defaults } from '../config/defaults';

export interface BastionStackProps extends cdk.StackProps {
  networkStack: NetworkStack;
}

/**
 * In-VPC bastion used solely as a vantage point for the failover validator.
 *
 * The validator's MgmtReachabilityInvariant probes the active FortiGate's Port2
 * PRIVATE IP (10.0.2.x / 10.0.12.x), which is only reachable from inside the VPC.
 * Running the validator here — instead of from a laptop — lets the pipeline prove
 * the project thesis: internal traffic reaches the new active's Port2 after the
 * route-table failover.
 *
 * SSM-managed (no SSH key, no inbound). The laptop stages the built validator to
 * the S3 bucket, then triggers it on this instance via SSM SendCommand.
 */
export class BastionStack extends cdk.Stack {
  public readonly validatorBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: BastionStackProps) {
    super(scope, id, props);

    const { vpc, publicSubnet1a, sgMgmt } = props.networkStack;

    // ─── Validator artifact bucket ────────────────────────────────────────────
    this.validatorBucket = new s3.Bucket(this, 'ValidatorBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    // ─── Bastion security group ───────────────────────────────────────────────
    // No ingress: SSM is outbound-initiated. Outbound open for EC2 API / S3 / SSM.
    const sgBastion = new ec2.SecurityGroup(this, 'SgBastion', {
      vpc,
      description: 'sg-bastion: in-VPC validator vantage (SSM-managed)',
      allowAllOutbound: true,
    });

    // Tight Port2 access: only the bastion SG may reach the FortiGate mgmt GUI.
    // Declared as a standalone ingress IN this stack (not via sgMgmt.addIngressRule)
    // so the dependency stays BastionStack -> NetworkStack and avoids a cycle.
    new ec2.CfnSecurityGroupIngress(this, 'BastionToPort2', {
      groupId: sgMgmt.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      sourceSecurityGroupId: sgBastion.securityGroupId,
      description: 'Bastion -> Port2 mgmt probe',
    });

    // ─── IAM role ─────────────────────────────────────────────────────────────
    const role = new iam.Role(this, 'BastionRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
      inlinePolicies: {
        ValidatorReadPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['ec2:DescribeInstances', 'ec2:DescribeAddresses'],
              resources: ['*'],
            }),
          ],
        }),
      },
    });
    this.validatorBucket.grantRead(role);

    // ─── Bastion instance ─────────────────────────────────────────────────────
    const userData = ec2.UserData.forLinux();
    userData.addCommands('dnf install -y nodejs tar');

    const bastion = new ec2.Instance(this, 'Bastion', {
      instanceType: new ec2.InstanceType(defaults.bastionInstanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      vpc,
      vpcSubnets: { subnets: [publicSubnet1a] },
      securityGroup: sgBastion,
      role,
      userData,
    });

    // EIP for internet egress (EC2 API / S3 / SSM). The public subnet has an IGW
    // route but mapPublicIpOnLaunch is false, so attach an EIP explicitly — same
    // pattern as the FortiGate WAN interface.
    const eip = new ec2.CfnEIP(this, 'BastionEip', { domain: 'vpc' });
    new ec2.CfnEIPAssociation(this, 'BastionEipAssoc', {
      allocationId: eip.attrAllocationId,
      instanceId: bastion.instanceId,
    });

    // ─── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'BastionInstanceId', { value: bastion.instanceId });
    new cdk.CfnOutput(this, 'ValidatorBucketName', { value: this.validatorBucket.bucketName });
  }
}
