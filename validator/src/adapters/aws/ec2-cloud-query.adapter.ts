import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeAddressesCommand,
  Instance,
  Address,
} from "@aws-sdk/client-ec2";
import { HANode, HAState, NodeRole } from "../../domain/ha-state";
import { CloudQueryPort } from "../../ports/cloud-query.port";

/**
 * AWS EC2 adapter for CloudQueryPort.
 * Queries EC2 instances by a tag filter and the associated Elastic IP
 * to build an HAState snapshot.
 *
 * Excluded from unit test coverage — this is boundary I/O.
 * Validated via e2e run against a real AWS account.
 */
export class Ec2CloudQuery implements CloudQueryPort {
  private readonly ec2: EC2Client;
  private readonly clusterTag: string;

  constructor(region: string, clusterTag: string) {
    this.ec2 = new EC2Client({ region });
    this.clusterTag = clusterTag;
  }

  async describeClusterState(): Promise<HAState> {
    const [instances, addresses] = await Promise.all([
      this.fetchInstances(),
      this.fetchAddresses(),
    ]);

    const eipInstanceIds = new Set(
      addresses
        .filter((a) => a.InstanceId !== undefined)
        .map((a) => a.InstanceId as string)
    );

    const nodes: HANode[] = instances.map((instance) => {
      const id = instance.InstanceId ?? "unknown";
      const hasWanEip = eipInstanceIds.has(id);
      // Role is determined by EIP ownership, not by the static FortigateHARole tag.
      // The tag is set at deploy time and never updated by FortiGate on failover.
      // After failover the new Active holds the EIP — that is the ground truth.
      const role = this.resolveRole(instance, hasWanEip);
      const priority = this.resolvePriority(instance);
      const port2PrivateIp = this.resolvePort2Ip(instance);

      return { id, role, priority, port2PrivateIp, hasWanEip };
    });

    return new HAState(nodes);
  }

  private async fetchInstances(): Promise<Instance[]> {
    const command = new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:FortigateHACluster", Values: [this.clusterTag] },
        { Name: "instance-state-name", Values: ["running", "terminated"] },
      ],
    });

    const response = await this.ec2.send(command);
    return (
      response.Reservations?.flatMap((r) => r.Instances ?? []) ?? []
    );
  }

  private async fetchAddresses(): Promise<Address[]> {
    const command = new DescribeAddressesCommand({
      Filters: [
        { Name: "tag:FortigateHACluster", Values: [this.clusterTag] },
      ],
    });

    const response = await this.ec2.send(command);
    return response.Addresses ?? [];
  }

  private resolveRole(instance: Instance, hasWanEip: boolean): NodeRole {
    const state = instance.State?.Name;
    if (state === "terminated" || state === "shutting-down") {
      return "TERMINATED";
    }
    if (hasWanEip) return "ACTIVE";
    return "PASSIVE";
  }

  private resolvePriority(instance: Instance): number {
    const tag = instance.Tags?.find(
      (t) => t.Key === "FortigateHAPriority"
    )?.Value;
    return tag !== undefined ? parseInt(tag, 10) : 100;
  }

  private resolvePort2Ip(instance: Instance): string {
    // Port2 (eth1) is the second network interface (index 1)
    const port2Nic = instance.NetworkInterfaces?.find(
      (nic) => nic.Attachment?.DeviceIndex === 1
    );
    return port2Nic?.PrivateIpAddress ?? "";
  }
}
