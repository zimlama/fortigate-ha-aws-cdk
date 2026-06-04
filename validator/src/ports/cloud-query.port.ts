import { HAState } from "../domain/ha-state";

export interface CloudQueryPort {
  /**
   * Reads the current HA cluster state from the cloud provider.
   * Returns nodes with their roles, priorities, EIP status, and Port2 IPs.
   */
  describeClusterState(): Promise<HAState>;
}
