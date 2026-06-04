import { HANode, HAState, NodeRole } from "../../src/domain/ha-state";

const makeNode = (
  id: string,
  role: NodeRole,
  port2PrivateIp: string,
  hasWanEip: boolean,
  priority = 100
): HANode => ({ id, role, priority, port2PrivateIp, hasWanEip });

describe("HAState", () => {
  describe("constructor", () => {
    it("stores nodes as a readonly array", () => {
      const nodes = [
        makeNode("i-001", "ACTIVE", "10.0.1.10", true),
        makeNode("i-002", "PASSIVE", "10.0.1.11", false),
      ];
      const state = new HAState(nodes);

      expect(state.nodes).toHaveLength(2);
    });
  });

  describe("activeNode()", () => {
    it("returns the node with role ACTIVE", () => {
      const active = makeNode("i-001", "ACTIVE", "10.0.1.10", true, 200);
      const passive = makeNode("i-002", "PASSIVE", "10.0.1.11", false, 100);
      const state = new HAState([active, passive]);

      expect(state.activeNode()).toEqual(active);
    });

    it("returns undefined when no ACTIVE node exists", () => {
      const state = new HAState([
        makeNode("i-001", "TERMINATED", "10.0.1.10", false),
        makeNode("i-002", "PASSIVE", "10.0.1.11", false),
      ]);

      expect(state.activeNode()).toBeUndefined();
    });
  });

  describe("eipHolder()", () => {
    it("returns the node holding the WAN EIP", () => {
      const eipNode = makeNode("i-002", "ACTIVE", "10.0.1.11", true);
      const state = new HAState([
        makeNode("i-001", "TERMINATED", "10.0.1.10", false),
        eipNode,
      ]);

      expect(state.eipHolder()).toEqual(eipNode);
    });

    it("returns undefined when no node holds the EIP", () => {
      const state = new HAState([
        makeNode("i-001", "TERMINATED", "10.0.1.10", false),
        makeNode("i-002", "PASSIVE", "10.0.1.11", false),
      ]);

      expect(state.eipHolder()).toBeUndefined();
    });
  });
});
