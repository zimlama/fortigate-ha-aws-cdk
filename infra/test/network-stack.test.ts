import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';

function buildTemplate(adminCidr?: string): Template {
  const app = new cdk.App({
    context: adminCidr ? { adminCidr } : {},
  });
  const stack = new NetworkStack(app, 'TestNetworkStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('NetworkStack', () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate('10.1.0.0/24');
  });

  test('creates exactly 8 subnets', () => {
    // public/private/ha/mgmt per AZ × 2 AZs
    template.resourceCountIs('AWS::EC2::Subnet', 8);
  });

  test('internet gateway is attached to the VPC', () => {
    template.resourceCountIs('AWS::EC2::InternetGateway', 1);
    template.resourceCountIs('AWS::EC2::VPCGatewayAttachment', 1);
    template.hasResourceProperties('AWS::EC2::VPCGatewayAttachment', {
      InternetGatewayId: Match.anyValue(),
      VpcId: Match.anyValue(),
    });
  });

  test('creates 4 security groups', () => {
    // sg-wan, sg-mgmt, sg-ha, sg-ha-mgmt
    template.resourceCountIs('AWS::EC2::SecurityGroup', 4);
  });

  test('sg-ha-mgmt (port4) allows admin HTTPS from adminCidr', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('sg-ha-mgmt'),
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ IpProtocol: 'tcp', FromPort: 443, CidrIp: '10.1.0.0/24' }),
      ]),
    });
  });

  test('sg-ha allows port 703 TCP within VPC only', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          IpProtocol: 'tcp',
          FromPort: 703,
          ToPort: 703,
          CidrIp: '10.0.0.0/16',
        }),
      ]),
    });
  });

  test('sg-mgmt uses adminCidr context value (not hardcoded)', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ IpProtocol: 'tcp', FromPort: 443, CidrIp: '10.1.0.0/24' }),
      ]),
    });
  });

  test('sg-mgmt falls back to 10.0.0.0/8 when adminCidr is not set', () => {
    const tmpl = buildTemplate();
    tmpl.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ IpProtocol: 'tcp', FromPort: 443, CidrIp: '10.0.0.0/8' }),
      ]),
    });
  });

  test('outputs VpcId, PrivateRouteTable1aId, PrivateRouteTable1bId', () => {
    const outputs = template.findOutputs('*');
    expect(Object.keys(outputs)).toContain('VpcId');
    expect(Object.keys(outputs)).toContain('PrivateRouteTable1aId');
    expect(Object.keys(outputs)).toContain('PrivateRouteTable1bId');
  });

  test('public route table has an IGW route', () => {
    template.hasResourceProperties('AWS::EC2::Route', {
      DestinationCidrBlock: '0.0.0.0/0',
      GatewayId: Match.anyValue(),
    });
  });
});
