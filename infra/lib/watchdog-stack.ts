import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { defaults } from '../config/defaults';

export interface WatchdogStackProps extends cdk.StackProps {}

/**
 * Cost safety net: after `labTimeoutMinutes`, an EventBridge rule invokes a Lambda
 * that deletes the lab stacks via CloudFormation, in reverse-dependency order.
 *
 * A Lambda (not CodeBuild) is used on purpose: `cdk destroy` needs the CDK app
 * source, which a CodeBuild project would have to stage from somewhere. Direct
 * `cloudformation:DeleteStack` calls need no source and are self-contained.
 * The Lambda also disables its own rule (one-shot) and deletes WatchdogStack last.
 */
export class WatchdogStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: WatchdogStackProps) {
    super(scope, id, props);

    // Fixed rule name (passed to the Lambda env) breaks the Rule<->Lambda cycle
    // that a token cross-reference (rule.ruleName) would create.
    const ruleName = 'WatchdogStack-AutoDestroy';

    const fn = new lambda.Function(this, 'WatchdogFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(15),
      code: lambda.Code.fromInline([
        'import boto3, os',
        'cfn = boto3.client("cloudformation")',
        'evt = boto3.client("events")',
        '',
        'def _delete_group(names):',
        '    existing = []',
        '    for n in names:',
        '        if not n:',
        '            continue',
        '        try:',
        '            cfn.describe_stacks(StackName=n)',
        '            cfn.delete_stack(StackName=n)',
        '            existing.append(n)',
        '        except Exception:',
        '            pass',
        '    waiter = cfn.get_waiter("stack_delete_complete")',
        '    for n in existing:',
        '        try:',
        '            waiter.wait(StackName=n, WaiterConfig={"Delay": 15, "MaxAttempts": 24})',
        '        except Exception:',
        '            pass',
        '',
        'def handler(event, context):',
        '    rule = os.environ.get("RULE_NAME")',
        '    if rule:',
        '        try: evt.disable_rule(Name=rule)',
        '        except Exception: pass',
        '    # importers of NetworkStack exports first, then the exporter',
        '    _delete_group(os.environ.get("IMPORTER_STACKS", "").split(","))',
        '    _delete_group(os.environ.get("EXPORTER_STACKS", "").split(","))',
        '    # remove ourselves last (fire-and-forget; delete_stack is async)',
        '    self_stack = os.environ.get("SELF_STACK")',
        '    if self_stack:',
        '        try: cfn.delete_stack(StackName=self_stack)',
        '        except Exception: pass',
      ].join('\n')),
      environment: {
        IMPORTER_STACKS: 'BastionStack,FortiGateStack',
        EXPORTER_STACKS: 'NetworkStack',
        SELF_STACK: 'WatchdogStack',
        RULE_NAME: ruleName,
      },
    });

    // CloudFormation deletes resources using the caller's (this Lambda's) creds,
    // so the role needs delete permissions across the lab's resource types.
    fn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudformation:DeleteStack',
        'cloudformation:DescribeStacks',
        'ec2:*',
        'iam:*',
        'lambda:*',
        'events:*',
        's3:*',
        'logs:*',
      ],
      resources: ['*'],
    }));

    const rule = new events.Rule(this, 'AutoDestroyRule', {
      ruleName,
      schedule: events.Schedule.rate(cdk.Duration.minutes(defaults.labTimeoutMinutes)),
    });
    rule.addTarget(new targets.LambdaFunction(fn));
  }
}
