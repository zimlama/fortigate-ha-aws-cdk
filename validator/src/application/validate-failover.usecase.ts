import { FailoverOutcome } from "../domain/failover-outcome";
import { EipMigrationInvariant } from "../domain/invariants";
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

    let pollCount = 0;

    while (Date.now() < deadline) {
      pollCount++;
      const elapsed = Math.round((Date.now() - (deadline - input.pollTimeoutMs)) / 1000);
      console.log(`\n[poll #${pollCount} | +${elapsed}s] Querying cluster state...`);

      const state = await this.cloud.describeClusterState();

      // Log raw node state for each cluster member
      for (const node of state.nodes) {
        console.log(
          `  node ${node.id}  role=${node.role}  hasWanEip=${node.hasWanEip}` +
          `  port2=${node.port2PrivateIp || "(none)"}  priority=${node.priority}`
        );
      }

      const reasons: string[] = [];

      // Evaluate EIP migration invariant
      const eipResult = EipMigrationInvariant.evaluate(state);
      if (!eipResult.satisfied && eipResult.reason) {
        console.log(`  EIP invariant: FAIL — ${eipResult.reason}`);
        reasons.push(eipResult.reason);
      } else {
        console.log(`  EIP invariant: OK`);
      }

      // Evaluate active node presence (required for EIP invariant to pass)
      const activeNode = state.activeNode();
      if (activeNode) {
        // Port2 is the LAN/traffic interface in FGCP HA — passive units keep it down.
        // Probe is informational: it succeeds once FortiOS fully promotes the new active
        // unit and re-enables its data interfaces. EIP migration is the authoritative proof.
        console.log(`  Probing Port2 at ${activeNode.port2PrivateIp} (informational)...`);
        const reachable = await this.net.isPort2MgmtReachable(
          activeNode.port2PrivateIp
        );
        console.log(`  Port2 reachable: ${reachable} (informational — not a pass/fail gate)`);
      } else {
        console.log(`  No active node found (EIP not yet migrated)`);
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
