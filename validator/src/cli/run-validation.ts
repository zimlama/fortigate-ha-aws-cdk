#!/usr/bin/env node
/**
 * CLI composition root — FortiGate HA failover validator.
 *
 * Usage:
 *   node dist/cli/run-validation.js <terminatedNodeId> [options]
 *
 * Options:
 *   --poll-interval <ms>   Polling interval in milliseconds (default: 5000)
 *   --poll-timeout <ms>    Total timeout in milliseconds (default: 120000)
 *   --region <region>      AWS region (default: us-east-1)
 *   --cluster-tag <tag>    FortigateHACluster tag value (default: fortigate-ha)
 *
 * Exit codes:
 *   0 — PASSED (failover validated successfully)
 *   1 — FAILED (invariants not satisfied or timeout)
 */

import { Ec2CloudQuery } from "../adapters/aws/ec2-cloud-query.adapter";
import { HttpsReachability } from "../adapters/net/https-reachability.adapter";
import { ValidateFailoverUseCase } from "../application/validate-failover.usecase";

// ──────────────────────────────────────────────────────────
// Argument parsing
// ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] !== undefined
    ? args[idx + 1]
    : defaultValue;
}

const terminatedNodeId = args[0];
if (!terminatedNodeId || terminatedNodeId.startsWith("--")) {
  console.error("Error: <terminatedNodeId> is required as the first argument.");
  console.error("Usage: run-validation <terminatedNodeId> [--poll-interval <ms>] [--poll-timeout <ms>]");
  process.exit(1);
}

const pollIntervalMs = parseInt(getArg("--poll-interval", "5000"), 10);
const pollTimeoutMs = parseInt(getArg("--poll-timeout", "120000"), 10);
const region = getArg("--region", "us-east-1");
const clusterTag = getArg("--cluster-tag", "fortigate-ha");

// ──────────────────────────────────────────────────────────
// Composition root — wire adapters into use case
// ──────────────────────────────────────────────────────────

const cloud = new Ec2CloudQuery(region, clusterTag);
const net = new HttpsReachability(pollIntervalMs);
const useCase = new ValidateFailoverUseCase(cloud, net);

// ──────────────────────────────────────────────────────────
// Execute
// ──────────────────────────────────────────────────────────

console.log(`FortiGate HA Failover Validator`);
console.log(`  Terminated node: ${terminatedNodeId}`);
console.log(`  Region: ${region}  Cluster tag: ${clusterTag}`);
console.log(`  Poll interval: ${pollIntervalMs}ms  Timeout: ${pollTimeoutMs}ms`);
console.log();

useCase
  .execute({ terminatedNodeId, pollIntervalMs, pollTimeoutMs })
  .then((outcome) => {
    if (outcome.isPassed()) {
      console.log("PASSED ✅  Failover validation succeeded.");
      process.exit(0);
    } else {
      console.error("FAILED ❌  Failover validation failed.");
      outcome.reasons.forEach((r) => console.error(`  - ${r}`));
      process.exit(1);
    }
  })
  .catch((err: unknown) => {
    console.error("FATAL: unexpected error during validation:", err);
    process.exit(1);
  });
