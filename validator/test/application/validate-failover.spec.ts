import { HANode, HAState, NodeRole } from "../../src/domain/ha-state";
import {
  ValidateFailoverUseCase,
  ValidateFailoverInput,
} from "../../src/application/validate-failover.usecase";
import { FakeCloudQuery } from "../fakes/fake-cloud-query";
import { FakeReachability } from "../fakes/fake-reachability";

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

const makeNode = (
  id: string,
  role: NodeRole,
  port2PrivateIp: string,
  hasWanEip: boolean,
  priority = 100
): HANode => ({ id, role, priority, port2PrivateIp, hasWanEip });

const NODE_A_IP = "10.0.1.10";
const NODE_B_IP = "10.0.1.11";

/** State AFTER successful failover: B is active with EIP */
const stateB_active_with_eip = new HAState([
  makeNode("i-A", "TERMINATED", NODE_A_IP, false, 200),
  makeNode("i-B", "ACTIVE", NODE_B_IP, true, 100),
]);

/** State where EIP has NOT migrated: B is active but EIP still on A */
const stateB_active_eip_on_A = new HAState([
  makeNode("i-A", "TERMINATED", NODE_A_IP, true, 200),
  makeNode("i-B", "ACTIVE", NODE_B_IP, false, 100),
]);

/** State where neither node holds the EIP */
const stateB_active_no_eip = new HAState([
  makeNode("i-A", "TERMINATED", NODE_A_IP, false, 200),
  makeNode("i-B", "ACTIVE", NODE_B_IP, false, 100),
]);

const FAST_POLL: Partial<ValidateFailoverInput> = {
  pollIntervalMs: 10,
  pollTimeoutMs: 50,
};

// ──────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────

describe("ValidateFailoverUseCase", () => {
  describe("S3.1 — Happy path", () => {
    it("returns PASSED when EIP migrated and Port2 is reachable", async () => {
      const cloud = new FakeCloudQuery([stateB_active_with_eip]);
      const net = new FakeReachability(new Set([NODE_B_IP]));
      const useCase = new ValidateFailoverUseCase(cloud, net);

      const outcome = await useCase.execute({
        terminatedNodeId: "i-A",
        pollIntervalMs: 10,
        pollTimeoutMs: 50,
      });

      expect(outcome.isPassed()).toBe(true);
      expect(outcome.reasons).toHaveLength(0);
    });
  });

  describe("S3.2 — EIP not migrated", () => {
    it("returns FAILED with EIP reason when EIP stays on passive/terminated node", async () => {
      const cloud = new FakeCloudQuery([stateB_active_eip_on_A]);
      const net = new FakeReachability(new Set([NODE_B_IP]));
      const useCase = new ValidateFailoverUseCase(cloud, net);

      const outcome = await useCase.execute({
        terminatedNodeId: "i-A",
        ...FAST_POLL,
      } as ValidateFailoverInput);

      expect(outcome.isPassed()).toBe(false);
      expect(outcome.reasons).toContain("EIP did not migrate");
    });
  });

  describe("S3.3 — Mgmt unreachable (the thesis case)", () => {
    it("returns FAILED with mgmt reason when Port2 is not reachable", async () => {
      const cloud = new FakeCloudQuery([stateB_active_with_eip]);
      const net = new FakeReachability(new Set()); // B's IP not in set
      const useCase = new ValidateFailoverUseCase(cloud, net);

      const outcome = await useCase.execute({
        terminatedNodeId: "i-A",
        ...FAST_POLL,
      } as ValidateFailoverInput);

      expect(outcome.isPassed()).toBe(false);
      expect(outcome.reasons).toContain(
        "mgmt unreachable on Port2 after failover"
      );
    });
  });

  describe("S3.4 — Both conditions fail", () => {
    it("returns FAILED with both EIP and mgmt reasons", async () => {
      const cloud = new FakeCloudQuery([stateB_active_no_eip]);
      const net = new FakeReachability(new Set()); // B's IP not reachable either
      const useCase = new ValidateFailoverUseCase(cloud, net);

      const outcome = await useCase.execute({
        terminatedNodeId: "i-A",
        ...FAST_POLL,
      } as ValidateFailoverInput);

      expect(outcome.isPassed()).toBe(false);
      expect(outcome.reasons).toContain("no EIP holder found");
      expect(outcome.reasons).toContain(
        "mgmt unreachable on Port2 after failover"
      );
    });
  });

  describe("S3.5 — Eventual consistency (delayed failover)", () => {
    it("returns PASSED after 3 polls when cluster converges on 3rd attempt", async () => {
      // First 2 polls: EIP not yet on B. 3rd poll: B is active with EIP.
      const cloud = new FakeCloudQuery([
        stateB_active_eip_on_A,  // poll 1 — EIP not migrated yet
        stateB_active_eip_on_A,  // poll 2 — still not migrated
        stateB_active_with_eip,  // poll 3 — migrated
      ]);
      const net = new FakeReachability(new Set([NODE_B_IP]));
      const useCase = new ValidateFailoverUseCase(cloud, net);

      const outcome = await useCase.execute({
        terminatedNodeId: "i-A",
        pollIntervalMs: 10,
        pollTimeoutMs: 200,  // generous enough for 3 polls at 10ms each
      });

      expect(outcome.isPassed()).toBe(true);
    });
  });

  describe("S3.6 — Timeout (failover never completes)", () => {
    it("returns FAILED with timeout reason when cluster never converges", async () => {
      const cloud = new FakeCloudQuery([stateB_active_eip_on_A]); // always fails
      const net = new FakeReachability(new Set([NODE_B_IP]));
      const useCase = new ValidateFailoverUseCase(cloud, net);

      const outcome = await useCase.execute({
        terminatedNodeId: "i-A",
        pollIntervalMs: 10,
        pollTimeoutMs: 50,
      });

      expect(outcome.isPassed()).toBe(false);
      expect(outcome.reasons.some((r) => r.includes("timed out"))).toBe(true);
    });
  });
});
