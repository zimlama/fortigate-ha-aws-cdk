export type NodeRole = "ACTIVE" | "PASSIVE" | "TERMINATED";

export interface HANode {
  readonly id: string;
  readonly role: NodeRole;
  readonly priority: number;
  readonly port2PrivateIp: string;
  readonly hasWanEip: boolean;
}

export class HAState {
  readonly nodes: ReadonlyArray<HANode>;

  constructor(nodes: ReadonlyArray<HANode>) {
    this.nodes = Object.freeze([...nodes]);
  }

  activeNode(): HANode | undefined {
    return this.nodes.find((n) => n.role === "ACTIVE");
  }

  eipHolder(): HANode | undefined {
    return this.nodes.find((n) => n.hasWanEip === true);
  }
}
