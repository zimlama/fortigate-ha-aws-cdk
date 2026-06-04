import { HANode, HAState } from "./ha-state";

export interface InvariantResult {
  satisfied: boolean;
  reason?: string;
}

export class EipMigrationInvariant {
  /**
   * Satisfied when the EIP holder is the active node.
   * S2.1: active node has EIP → satisfied
   * S2.2: active node does NOT have EIP (someone else holds it) → violated
   * S2.3: no EIP holder at all → violated
   */
  static evaluate(state: HAState): InvariantResult {
    const holder = state.eipHolder();

    if (!holder) {
      return { satisfied: false, reason: "no EIP holder found" };
    }

    const active = state.activeNode();
    if (!active || holder.id !== active.id) {
      return { satisfied: false, reason: "EIP did not migrate" };
    }

    return { satisfied: true };
  }
}

export class MgmtReachabilityInvariant {
  /**
   * Satisfied when the active node's Port2 management IP is reachable.
   * S2.4: reachable → satisfied
   * S2.5: not reachable → violated (the thesis case)
   */
  static evaluate(activeNode: HANode, port2Reachable: boolean): InvariantResult {
    if (!port2Reachable) {
      return {
        satisfied: false,
        reason: "mgmt unreachable on Port2 after failover",
      };
    }

    return { satisfied: true };
  }
}
