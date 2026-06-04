import { FailoverOutcome } from "../../src/domain/failover-outcome";

describe("FailoverOutcome", () => {
  describe("S1.1 — passed() factory", () => {
    it("produces status PASSED, empty reasons, and isPassed() true", () => {
      const outcome = FailoverOutcome.passed();

      expect(outcome.status).toBe("PASSED");
      expect(outcome.isPassed()).toBe(true);
      expect(outcome.reasons).toHaveLength(0);
    });
  });

  describe("S1.2 — failed() factory with one reason", () => {
    it("produces status FAILED, preserves reason, and isPassed() false", () => {
      const outcome = FailoverOutcome.failed(["EIP did not migrate"]);

      expect(outcome.status).toBe("FAILED");
      expect(outcome.isPassed()).toBe(false);
      expect(outcome.reasons).toEqual(["EIP did not migrate"]);
    });
  });

  describe("S1.3 — failed() factory with two reasons", () => {
    it("preserves order of both reasons", () => {
      const outcome = FailoverOutcome.failed(["reason A", "reason B"]);

      expect(outcome.reasons).toEqual(["reason A", "reason B"]);
    });
  });

  describe("S1.4 — immutability under external mutation", () => {
    it("reasons array is immutable — external push has no effect", () => {
      const outcome = FailoverOutcome.failed(["original"]);

      // TypeScript types prevent push at compile time, but we verify runtime safety
      expect(() => {
        (outcome.reasons as string[]).push("injected");
      }).toThrow();

      expect(outcome.reasons).toEqual(["original"]);
    });
  });
});
