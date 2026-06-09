import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { BastionStack } from '../lib/bastion-stack';

function buildStacks(): { template: Template } {
  const app = new cdk.App({ context: { adminCidr: '10.1.0.0/24' } });
  const env = { account: '123456789012', region: 'us-east-1' };

  const networkStack = new NetworkStack(app, 'NetworkStack', { env });
  const bastionStack = new BastionStack(app, 'BastionStack', { env, networkStack });
  bastionStack.addDependency(networkStack);

  return { template: Template.fromStack(bastionStack) };
}

describe('BastionStack', () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = buildStacks());
  });

  test('creates a single t3.micro bastion instance', () => {
    template.resourceCountIs('AWS::EC2::Instance', 1);
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3.micro',
    });
  });

  test('creates one private S3 bucket for the validator artifact', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        RestrictPublicBuckets: true,
      }),
    });
  });

  test('bastion role attaches the SSM managed policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp('AmazonSSMManagedInstanceCore')]),
          ]),
        }),
      ]),
    });
  });

  test('bastion role can read EC2 for the validator', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: Match.arrayWith([
                  'ec2:DescribeInstances',
                  'ec2:DescribeAddresses',
                ]),
              }),
            ]),
          }),
        }),
      ]),
    });
  });

  test('opens cross-stack ingress for the bastion SG: Port2 443/22 and Port4 22', () => {
    // BastionToPort2 (443), BastionToPort2Ssh (22), BastionToPort4Ssh (22)
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 3);
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 22,
      ToPort: 22,
    });
  });

  test('outputs the bastion instance id and validator bucket name', () => {
    const outputs = template.findOutputs('*');
    expect(Object.keys(outputs)).toContain('BastionInstanceId');
    expect(Object.keys(outputs)).toContain('ValidatorBucketName');
  });
});
