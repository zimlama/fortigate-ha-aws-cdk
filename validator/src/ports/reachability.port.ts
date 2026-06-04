export interface ReachabilityPort {
  /**
   * Probes whether the FortiGate management interface on Port2 responds.
   * Port2 carries management traffic on the INTERNAL subnet (RFC-001).
   * Returns true if port 443 responds, false otherwise.
   */
  isPort2MgmtReachable(ip: string): Promise<boolean>;
}
