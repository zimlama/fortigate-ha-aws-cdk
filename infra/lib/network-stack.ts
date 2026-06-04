import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { defaults } from '../config/defaults';

export interface NetworkStackProps extends cdk.StackProps {}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly publicSubnet1a: ec2.Subnet;
  public readonly privateSubnet1a: ec2.Subnet;
  public readonly haSubnet1a: ec2.Subnet;
  public readonly publicSubnet1b: ec2.Subnet;
  public readonly privateSubnet1b: ec2.Subnet;
  public readonly haSubnet1b: ec2.Subnet;
  public readonly sgWan: ec2.SecurityGroup;
  public readonly sgMgmt: ec2.SecurityGroup;
  public readonly sgHa: ec2.SecurityGroup;
  public readonly rtPrivate1a: ec2.IRouteTable;
  public readonly rtPrivate1b: ec2.IRouteTable;

  constructor(scope: Construct, id: string, props?: NetworkStackProps) {
    super(scope, id, props);

    const adminCidr: string = this.node.tryGetContext('adminCidr') ?? '10.0.0.0/8';

    // ─── VPC ────────────────────────────────────────────────────────────────
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(defaults.vpcCidr),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [],   // subnets created manually for exact CIDRs
      createInternetGateway: false,
    });

    // ─── Internet Gateway ───────────────────────────────────────────────────
    const igw = new ec2.CfnInternetGateway(this, 'Igw');
    new ec2.CfnVPCGatewayAttachment(this, 'IgwAttachment', {
      vpcId: this.vpc.vpcId,
      internetGatewayId: igw.ref,
    });

    // ─── Subnets ────────────────────────────────────────────────────────────
    this.publicSubnet1a = new ec2.Subnet(this, 'SubnetPublic1a', {
      vpcId: this.vpc.vpcId,
      cidrBlock: defaults.subnets.publicA,
      availabilityZone: `${this.region}a`,
      mapPublicIpOnLaunch: false,
    });

    this.privateSubnet1a = new ec2.Subnet(this, 'SubnetPrivate1a', {
      vpcId: this.vpc.vpcId,
      cidrBlock: defaults.subnets.privateA,
      availabilityZone: `${this.region}a`,
    });

    this.haSubnet1a = new ec2.Subnet(this, 'SubnetHa1a', {
      vpcId: this.vpc.vpcId,
      cidrBlock: defaults.subnets.haA,
      availabilityZone: `${this.region}a`,
    });

    this.publicSubnet1b = new ec2.Subnet(this, 'SubnetPublic1b', {
      vpcId: this.vpc.vpcId,
      cidrBlock: defaults.subnets.publicB,
      availabilityZone: `${this.region}b`,
      mapPublicIpOnLaunch: false,
    });

    this.privateSubnet1b = new ec2.Subnet(this, 'SubnetPrivate1b', {
      vpcId: this.vpc.vpcId,
      cidrBlock: defaults.subnets.privateB,
      availabilityZone: `${this.region}b`,
    });

    this.haSubnet1b = new ec2.Subnet(this, 'SubnetHa1b', {
      vpcId: this.vpc.vpcId,
      cidrBlock: defaults.subnets.haB,
      availabilityZone: `${this.region}b`,
    });

    // ─── Route Tables ────────────────────────────────────────────────────────
    // ec2.Subnet auto-creates a route table + association per subnet.
    // We reuse those — adding routes directly avoids duplicate associations
    // (two associations on the same subnet cause CloudFormation NotStabilized).

    // Public subnets: add IGW default route to the auto-created route tables
    this.publicSubnet1a.addRoute('IgwRoute1a', {
      routerId: igw.ref,
      routerType: ec2.RouterType.GATEWAY,
      destinationCidrBlock: '0.0.0.0/0',
      enablesInternetConnectivity: true,
    });
    this.publicSubnet1b.addRoute('IgwRoute1b', {
      routerId: igw.ref,
      routerType: ec2.RouterType.GATEWAY,
      destinationCidrBlock: '0.0.0.0/0',
      enablesInternetConnectivity: true,
    });

    // Private subnets: reuse auto-created route tables (FortiGate SDN connector
    // calls ec2:ReplaceRoute on these tables during failover)
    this.rtPrivate1a = this.privateSubnet1a.routeTable;
    this.rtPrivate1b = this.privateSubnet1b.routeTable;

    // ─── Security Groups ─────────────────────────────────────────────────────

    // sg-wan: Port1 — public WAN
    this.sgWan = new ec2.SecurityGroup(this, 'SgWan', {
      vpc: this.vpc,
      description: 'sg-wan: Port1 public WAN',
      allowAllOutbound: true,
    });
    this.sgWan.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443),   'HTTPS management / SSL-VPN');
    this.sgWan.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(500),   'IKEv2 Phase 1');
    this.sgWan.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(4500),  'IKEv2 NAT-T');
    this.sgWan.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allIcmp(),  'Health probes');

    // sg-mgmt: Port2 — admin (RFC-001)
    this.sgMgmt = new ec2.SecurityGroup(this, 'SgMgmt', {
      vpc: this.vpc,
      description: 'sg-mgmt: Port2 admin access RFC-001',
      allowAllOutbound: true,
    });
    this.sgMgmt.addIngressRule(ec2.Peer.ipv4(adminCidr), ec2.Port.tcp(443), 'HTTPS GUI');
    this.sgMgmt.addIngressRule(ec2.Peer.ipv4(adminCidr), ec2.Port.tcp(22),  'SSH CLI');

    // sg-ha: Port3 — heartbeat only
    this.sgHa = new ec2.SecurityGroup(this, 'SgHa', {
      vpc: this.vpc,
      description: 'sg-ha: Port3 FGCP heartbeat',
      allowAllOutbound: false,
    });
    this.sgHa.addIngressRule(
      ec2.Peer.ipv4(defaults.vpcCidr), ec2.Port.tcp(defaults.haPort), 'FGCP heartbeat TCP',
    );
    this.sgHa.addIngressRule(
      ec2.Peer.ipv4(defaults.vpcCidr), ec2.Port.udp(defaults.haPort), 'FGCP heartbeat UDP',
    );
    this.sgHa.addEgressRule(
      ec2.Peer.ipv4(defaults.vpcCidr), ec2.Port.tcp(defaults.haPort), 'FGCP heartbeat TCP out',
    );
    this.sgHa.addEgressRule(
      ec2.Peer.ipv4(defaults.vpcCidr), ec2.Port.udp(defaults.haPort), 'FGCP heartbeat UDP out',
    );

    // ─── Outputs ─────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'PrivateRouteTable1aId', { value: this.rtPrivate1a.routeTableId });
    new cdk.CfnOutput(this, 'PrivateRouteTable1bId', { value: this.rtPrivate1b.routeTableId });
  }
}
