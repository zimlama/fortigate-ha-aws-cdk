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

  test('Lambda timeout is 30 seconds', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 30,
    });
  });

  test('CodeBuild project uses buildspec with npm ci and cdk destroy', () => {
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Source: Match.objectLike({
        BuildSpec: Match.serializedJson(
          Match.objectLike({
            phases: Match.objectLike({
              install: Match.objectLike({ commands: Match.arrayWith(['npm ci']) }),
              build:   Match.objectLike({ commands: Match.arrayWith(['npx cdk destroy --all --force --ci']) }),
            }),
          }),
        ),
      }),
    });
  });

  test('CodeBuild project uses STANDARD_7_0 build image', () => {
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({
        Image: Match.stringLikeRegexp('aws/codebuild/standard:7.0'),
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
