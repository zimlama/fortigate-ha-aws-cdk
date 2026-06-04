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
  public readonly rtPrivate1a: ec2.CfnRouteTable;
  public readonly rtPrivate1b: ec2.CfnRouteTable;

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
    // Public: IGW route, associated to both public subnets
    const rtPublic = new ec2.CfnRouteTable(this, 'RtPublic', { vpcId: this.vpc.vpcId });

    new ec2.CfnRoute(this, 'RtPublicDefault', {
      routeTableId: rtPublic.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: igw.ref,
    });

    new ec2.CfnSubnetRouteTableAssociation(this, 'RtPublicAssoc1a', {
      routeTableId: rtPublic.ref,
      subnetId: this.publicSubnet1a.subnetId,
    });

    new ec2.CfnSubnetRouteTableAssociation(this, 'RtPublicAssoc1b', {
      routeTableId: rtPublic.ref,
      subnetId: this.publicSubnet1b.subnetId,
    });

    // Private-1a: 0.0.0.0/0 → Port2-A ENI (updated on failover)
    this.rtPrivate1a = new ec2.CfnRouteTable(this, 'RtPrivate1a', { vpcId: this.vpc.vpcId });

    new ec2.CfnSubnetRouteTableAssociation(this, 'RtPrivate1aAssoc', {
      routeTableId: this.rtPrivate1a.ref,
      subnetId: this.privateSubnet1a.subnetId,
    });

    // Private-1b: 0.0.0.0/0 → Port2-A ENI initially (updated on failover)
    this.rtPrivate1b = new ec2.CfnRouteTable(this, 'RtPrivate1b', { vpcId: this.vpc.vpcId });

    new ec2.CfnSubnetRouteTableAssociation(this, 'RtPrivate1bAssoc', {
      routeTableId: this.rtPrivate1b.ref,
      subnetId: this.privateSubnet1b.subnetId,
    });

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
    new cdk.CfnOutput(this, 'PrivateRouteTable1aId', { value: this.rtPrivate1a.ref });
    new cdk.CfnOutput(this, 'PrivateRouteTable1bId', { value: this.rtPrivate1b.ref });
  }
}
