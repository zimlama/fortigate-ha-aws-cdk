import { ReachabilityPort } from "../../src/ports/reachability.port";

/**
 * In-memory fake for ReachabilityPort.
 * Returns true if the given IP is in the reachable set, false otherwise.
 *
 * Use an empty Set to simulate total network failure.
 * Add specific IPs to simulate partial reachability.
 */
export class FakeReachability implements ReachabilityPort {
  private readonly reachableIps: Set<string>;

  constructor(reachableIps: Set<string>) {
    this.reachableIps = reachableIps;
  }

  async isPort2MgmtReachable(ip: string): Promise<boolean> {
    return this.reachableIps.has(ip);
  }
}
