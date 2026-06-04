import { FailoverOutcome } from "../domain/failover-outcome";
import {
  EipMigrationInvariant,
  MgmtReachabilityInvariant,
} from "../domain/invariants";
import { CloudQueryPort } from "../ports/cloud-query.port";
import { ReachabilityPort } from "../ports/reachability.port";

export interface ValidateFailoverInput {
  terminatedNodeId: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

export class ValidateFailoverUseCase {
  constructor(
    private readonly cloud: CloudQueryPort,
    private readonly net: ReachabilityPort
  ) {}

  async execute(input: ValidateFailoverInput): Promise<FailoverOutcome> {
    const { pollIntervalMs, pollTimeoutMs } = input;
    const deadline = Date.now() + pollTimeoutMs;

    let lastReasons: string[] = [];

    while (Date.now() < deadline) {
      const state = await this.cloud.describeClusterState();
      const reasons: string[] = [];

      // Evaluate EIP migration invariant
      const eipResult = EipMigrationInvariant.evaluate(state);
      if (!eipResult.satisfied && eipResult.reason) {
        reasons.push(eipResult.reason);
      }

      // Evaluate management reachability invariant
      const activeNode = state.activeNode();
      if (activeNode) {
        const reachable = await this.net.isPort2MgmtReachable(
          activeNode.port2PrivateIp
        );
        const mgmtResult = MgmtReachabilityInvariant.evaluate(
          activeNode,
          reachable
        );
        if (!mgmtResult.satisfied && mgmtResult.reason) {
          reasons.push(mgmtResult.reason);
        }
      } else {
        reasons.push("no active node found");
      }

      // All invariants satisfied — return PASSED immediately
      if (reasons.length === 0) {
        return FailoverOutcome.passed();
      }

      lastReasons = reasons;

      // Wait before next poll (only if time remains)
      if (Date.now() + pollIntervalMs < deadline) {
        await this.sleep(pollIntervalMs);
      } else {
        break;
      }
    }

    // Timeout — return FAILED with accumulated reasons + timeout notice
    const timeoutMs = pollTimeoutMs;
    return FailoverOutcome.failed([
      ...lastReasons,
      `validation timed out after ${timeoutMs}ms`,
    ]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
