#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { FortiGateStack } from '../lib/fortigate-stack';
import { WatchdogStack } from '../lib/watchdog-stack';
import { BastionStack } from '../lib/bastion-stack';

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
