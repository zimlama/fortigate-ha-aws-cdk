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

  test('creates exactly 8 ENIs', () => {
    // port1-4 per unit × 2 units (port4 = dedicated HA-management)
    template.resourceCountIs('AWS::EC2::NetworkInterface', 8);
  });

  test('all ENIs have sourceDestCheck: false', () => {
    template.allResourcesProperties('AWS::EC2::NetworkInterface', {
      SourceDestCheck: false,
    });
  });

  test('IAM role has the required failover actions as an inline policy', () => {
    // CDK renders iam.Role inlinePolicies as AWS::IAM::Role Policies property,
    // NOT as a standalone AWS::IAM::Policy resource.
    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                // arrayWith matches as an ordered subsequence — keep this in the
                // same order the stack declares the actions.
                Action: Match.arrayWith([
                  'ec2:Describe*',
                  'ec2:AssociateAddress',
                  'ec2:DisassociateAddress',
                  'ec2:AssignPrivateIpAddresses',
                  'ec2:UnassignPrivateIpAddresses',
                  'ec2:ReplaceRoute',
                ]),
              }),
            ]),
          }),
        }),
      ]),
    });
  });

  test('three EIPs exist (1 failover WAN VIP + 2 per-unit HA-mgmt)', () => {
    template.resourceCountIs('AWS::EC2::EIP', 3);
    template.resourceCountIs('AWS::EC2::EIPAssociation', 3);
    template.hasResourceProperties('AWS::EC2::EIPAssociation', {
      NetworkInterfaceId: Match.anyValue(),
      AllocationId: Match.anyValue(),
    });
  });

  test('only the failover WAN EIP carries the cluster tag (mgmt EIPs must not)', () => {
    const eips = template.findResources('AWS::EC2::EIP');
    const taggedWithCluster = Object.values(eips).filter((eip: any) =>
      (eip.Properties?.Tags ?? []).some(
        (t: any) => t.Key === 'FortigateHACluster',
      ),
    );
    expect(taggedWithCluster).toHaveLength(1);
  });

  test('two EC2 instances are created (Active + Passive)', () => {
    template.resourceCountIs('AWS::EC2::Instance', 2);
  });

  test('instances have EBS optimization and detailed monitoring enabled', () => {
    template.allResourcesProperties('AWS::EC2::Instance', {
      EbsOptimized: true,
      Monitoring: true,
    });
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
