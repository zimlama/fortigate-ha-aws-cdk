import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WatchdogStack } from '../lib/watchdog-stack';

function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new WatchdogStack(app, 'TestWatchdogStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('WatchdogStack', () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  test('EventBridge rule fires every 30 minutes', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(30 minutes)',
    });
  });

  test('Lambda runtime is PYTHON_3_12', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
    });
  });

  test('Lambda timeout covers CloudFormation deletes (900s)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 900,
    });
  });

  test('no CodeBuild project (deletes go straight through CloudFormation)', () => {
    template.resourceCountIs('AWS::CodeBuild::Project', 0);
  });

  test('Lambda role can delete stacks and lab resources', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'cloudformation:DeleteStack',
              'cloudformation:DescribeStacks',
            ]),
          }),
        ]),
      }),
    });
  });

  test('Lambda knows which stacks to delete and in which order', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          IMPORTER_STACKS: 'BastionStack,FortiGateStack',
          EXPORTER_STACKS: 'NetworkStack',
          SELF_STACK: 'WatchdogStack',
        }),
      }),
    });
  });

  test('Lambda is added as an EventBridge rule target', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Targets: Match.arrayWith([
        Match.objectLike({ Arn: Match.anyValue() }),
      ]),
    });
  });
});
