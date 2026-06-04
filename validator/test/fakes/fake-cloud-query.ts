import { HAState } from "../../src/domain/ha-state";
import { CloudQueryPort } from "../../src/ports/cloud-query.port";

/**
 * In-memory fake for CloudQueryPort.
 * Simulates the temporal evolution of the HA cluster state across polls.
 *
 * Behaviour: each call to describeClusterState() dequeues the next HAState
 * from the queue. When the queue is exhausted, the last item repeats.
 * This models eventual consistency: the cluster may still show the old active
 * node for the first N calls, then converge to the new state.
 */
export class FakeCloudQuery implements CloudQueryPort {
  private readonly states: HAState[];
  private index = 0;

  constructor(states: HAState[]) {
    if (states.length === 0) {
      throw new Error("FakeCloudQuery requires at least one HAState");
    }
    this.states = states;
  }

  async describeClusterState(): Promise<HAState> {
    const state = this.states[this.index];
    if (this.index < this.states.length - 1) {
      this.index++;
    }
    return state;
  }

  /** Returns how many times describeClusterState has been called. */
  get callCount(): number {
    return this.index + (this.index === this.states.length - 1 ? 1 : 0);
  }
}
