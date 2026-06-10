#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { FortiGateStack } from '../lib/fortigate-stack';
import { WatchdogStack } from '../lib/watchdog-stack';
import { BastionStack } from '../lib/bastion-stack';

// Guard: block any CDK invocation that doesn't have DEPLOY_VIA_SCRIPT=1.
// The only authorized entry point is scripts/deploy-and-test.sh, which
// sets DEPLOY_VIA_SCRIPT=1. Any direct `cdk deploy`, `cdk destroy`,
// `cdk synth`, `cdk diff` etc. from a terminal will hit this guard.
//
// Why we don't try to detect the CDK subcommand here:
// CDK invokes this script as a ts-node sub-process. process.argv[2] is
// the path to bin/app.ts, not the CDK subcommand. Trying to read the
// subcommand requires heuristics that are fragile and CDK-version-dependent.
// Trusting only the DEPLOY_VIA_SCRIPT env var is robust.
//
// This guard is a UX safety net, NOT a security boundary. The real
// anti-cost safety nets are: (1) trap cleanup EXIT in the script,
// (2) WatchdogStack EventBridge rule, (3) AccountGuardian Lambda,
// (4) AWS Budgets + Anomaly Detection. See docs/PROTECTIONS.md.
if (process.env.DEPLOY_VIA_SCRIPT !== '1') {
  process.stderr.write(
    '\n❌  Direct CDK invocation is blocked.\n' +
    '    The DEPLOY_VIA_SCRIPT env var is not set.\n' +
    '    Use: AWS_PROFILE=<profile> HA_PASSWORD=<secret> ./scripts/deploy-and-test.sh\n\n' +
    '    (Anti-cost protections: see docs/PROTECTIONS.md.)\n'
  );
  process.exit(1);
}

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const networkStack = new NetworkStack(app, 'NetworkStack', { env });

const fortiGateStack = new FortiGateStack(app, 'FortiGateStack', {
  env,
  networkStack,
});
fortiGateStack.addDependency(networkStack);

const bastionStack = new BastionStack(app, 'BastionStack', {
  env,
  networkStack,
});
bastionStack.addDependency(fortiGateStack);

const watchdogStack = new WatchdogStack(app, 'WatchdogStack', { env });
watchdogStack.addDependency(fortiGateStack);

app.synth();
