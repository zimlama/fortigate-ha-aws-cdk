export type OutcomeStatus = "PASSED" | "FAILED";

export class FailoverOutcome {
  readonly status: OutcomeStatus;
  readonly reasons: ReadonlyArray<string>;

  private constructor(status: OutcomeStatus, reasons: ReadonlyArray<string>) {
    this.status = status;
    // Defensive copy + freeze to enforce immutability (S1.4)
    this.reasons = Object.freeze([...reasons]);
  }

  static passed(): FailoverOutcome {
    return new FailoverOutcome("PASSED", []);
  }

  static failed(reasons: string[]): FailoverOutcome {
    return new FailoverOutcome("FAILED", reasons);
  }

  isPassed(): boolean {
    return this.status === "PASSED";
  }
}
