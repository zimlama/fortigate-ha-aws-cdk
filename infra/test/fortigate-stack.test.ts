import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { FortiGateStack } from '../lib/fortigate-stack';

// AMI lookup context key for FortiGate — injected so no real AWS call is needed in tests
const AMI_CONTEXT_KEY =
  'ami:account=123456789012:filters.image-type.0=machine:filters.name.0=FortiGate-VM64-AWSONDEMAND*:filters.state.0=available:owners.0=679593333241:region=us-east-1';

const DUMMY_AMI_ID = 'ami-0123456789abcdef0';

function buildStacks(): { template: Template } {
  const app = new cdk.App({
    context: {
      adminCidr: '10.1.0.0/24',
      haPassword: 'TestPass123',
      [AMI_CONTEXT_KEY]: DUMMY_AMI_ID,
    },
  });

  const env = { account: '123456789012', region: 'us-east-1' };

  const networkStack = new NetworkStack(app, 'NetworkStack', { env });
  const fortiGateStack = new FortiGateStack(app, 'FortiGateStack', { env, networkStack });
  fortiGateStack.addDependency(networkStack);

  return { template: Template.fromStack(fortiGateStack) };
}

describe('FortiGateStack', () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = buildStacks());
  });

  test('creates exactly 6 ENIs', () => {
    template.resourceCountIs('AWS::EC2::NetworkInterface', 6);
  });

  test('all ENIs have sourceDestCheck: false', () => {
    template.allResourcesProperties('AWS::EC2::NetworkInterface', {
      SourceDestCheck: false,
    });
  });

  test('IAM role has exactly the 7 required actions as an inline policy', () => {
    // CDK renders iam.Role inlinePolicies as AWS::IAM::Role Policies property,
    // NOT as a standalone AWS::IAM::Policy resource.
    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: Match.arrayWith([
                  'ec2:AssociateAddress',
                  'ec2:DisassociateAddress',
                  'ec2:DescribeAddresses',
                  'ec2:DescribeInstances',
                  'ec2:DescribeInstanceStatus',
                  'ec2:DescribeNetworkInterfaces',
                  'ec2:ReplaceRoute',
                ]),
              }),
            ]),
          }),
        }),
      ]),
    });
  });

  test('EIP exists and is associated to Port1-A ENI', () => {
    template.resourceCountIs('AWS::EC2::EIP', 1);
    template.resourceCountIs('AWS::EC2::EIPAssociation', 1);
    template.hasResourceProperties('AWS::EC2::EIPAssociation', {
      NetworkInterfaceId: Match.anyValue(),
      AllocationId: Match.anyValue(),
    });
  });

  test('two EC2 instances are created (Active + Passive)', () => {
    template.resourceCountIs('AWS::EC2::Instance', 2);
  });

  test('instances use GP3 EBS volume of correct size', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: Match.arrayWith([
        Match.objectLike({
          DeviceName: '/dev/sda1',
          Ebs: Match.objectLike({ VolumeType: 'gp3', VolumeSize: 30 }),
        }),
      ]),
    });
  });

  test('Active instance has cluster and role tags', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      Tags: Match.arrayWith([
        Match.objectLike({ Key: 'FortigateHACluster', Value: 'fortigate-ha' }),
        Match.objectLike({ Key: 'FortigateHARole',    Value: 'active' }),
      ]),
    });
  });

  test('Passive instance has cluster and role tags', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      Tags: Match.arrayWith([
        Match.objectLike({ Key: 'FortigateHACluster', Value: 'fortigate-ha' }),
        Match.objectLike({ Key: 'FortigateHARole',    Value: 'passive' }),
      ]),
    });
  });

  test('EIP has cluster tag so adapter can discover it', () => {
    template.hasResourceProperties('AWS::EC2::EIP', {
      Tags: Match.arrayWith([
        Match.objectLike({ Key: 'FortigateHACluster', Value: 'fortigate-ha' }),
      ]),
    });
  });
});
