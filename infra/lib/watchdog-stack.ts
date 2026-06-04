import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { defaults } from '../config/defaults';

export interface WatchdogStackProps extends cdk.StackProps {}

export class WatchdogStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: WatchdogStackProps) {
    super(scope, id, props);

    // ─── CodeBuild role ───────────────────────────────────────────────────────
    const codeBuildRole = new iam.Role(this, 'DestroyProjectRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      inlinePolicies: {
        DestroyPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'cloudformation:*',
                'ec2:*',
                'iam:*',
                'lambda:*',
                'events:*',
                'codebuild:*',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // ─── CodeBuild project ────────────────────────────────────────────────────
    const destroyProject = new codebuild.Project(this, 'DestroyProject', {
      role: codeBuildRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: { commands: ['npm ci'] },
          build:   { commands: ['npx cdk destroy --all --force --ci'] },
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
    });

    // ─── Lambda trigger ───────────────────────────────────────────────────────
    const fn = new lambda.Function(this, 'WatchdogFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'import boto3, os\n' +
        'def handler(event, context):\n' +
        '    cb = boto3.client(\'codebuild\')\n' +
        '    cb.start_build(projectName=os.environ[\'CODEBUILD_PROJECT\'])\n',
      ),
      environment: {
        CODEBUILD_PROJECT: destroyProject.projectName,
      },
      timeout: cdk.Duration.seconds(defaults.labTimeout),
    });

    // Grant Lambda permission to start the CodeBuild build
    fn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['codebuild:StartBuild'],
      resources: [destroyProject.projectArn],
    }));

    // ─── EventBridge rule ─────────────────────────────────────────────────────
    const rule = new events.Rule(this, 'AutoDestroyRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(defaults.labTimeout)),
    });

    rule.addTarget(new targets.LambdaFunction(fn));
  }
}
