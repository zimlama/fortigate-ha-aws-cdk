import { HANode, HAState, NodeRole } from "../../src/domain/ha-state";
import {
  EipMigrationInvariant,
  MgmtReachabilityInvariant,
} from "../../src/domain/invariants";

const makeNode = (
  id: string,
  role: NodeRole,
  port2PrivateIp: string,
  hasWanEip: boolean,
  priority = 100
): HANode => ({ id, role, priority, port2PrivateIp, hasWanEip });

describe("EipMigrationInvariant", () => {
  describe("S2.1 — EIP migrated to active node", () => {
    it("is satisfied when active node holds the EIP", () => {
      const state = new HAState([
        makeNode("i-A", "TERMINATED", "10.0.1.10", false),
        makeNode("i-B", "ACTIVE", "10.0.1.11", true, 200),
      ]);

      const result = EipMigrationInvariant.evaluate(state);

      expect(result.satisfied).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe("S2.2 — EIP still on passive/terminated node", () => {
    it("is violated when active node does not hold the EIP", () => {
      const state = new HAState([
        makeNode("i-A", "TERMINATED", "10.0.1.10", true),
        makeNode("i-B", "ACTIVE", "10.0.1.11", false, 200),
      ]);

      const result = EipMigrationInvariant.evaluate(state);

      expect(result.satisfied).toBe(false);
      expect(result.reason).toBe("EIP did not migrate");
    });
  });

  describe("S2.3 — No EIP holder at all", () => {
    it("is violated when no node holds the EIP", () => {
      const state = new HAState([
        makeNode("i-A", "TERMINATED", "10.0.1.10", false),
        makeNode("i-B", "ACTIVE", "10.0.1.11", false, 200),
      ]);

      const result = EipMigrationInvariant.evaluate(state);

      expect(result.satisfied).toBe(false);
      expect(result.reason).toBe("no EIP holder found");
    });
  });
});

describe("MgmtReachabilityInvariant", () => {
  describe("S2.4 — Port2 management reachable", () => {
    it("is satisfied when active node Port2 is reachable", () => {
      const activeNode = makeNode("i-B", "ACTIVE", "10.0.1.11", true, 200);

      const result = MgmtReachabilityInvariant.evaluate(activeNode, true);

      expect(result.satisfied).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe("S2.5 — Port2 management unreachable", () => {
    it("is violated when active node Port2 is not reachable", () => {
      const activeNode = makeNode("i-B", "ACTIVE", "10.0.1.11", true, 200);

      const result = MgmtReachabilityInvariant.evaluate(activeNode, false);

      expect(result.satisfied).toBe(false);
      expect(result.reason).toBe("mgmt unreachable on Port2 after failover");
    });
  });
});
