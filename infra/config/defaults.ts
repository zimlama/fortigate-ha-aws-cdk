export const defaults = {
  vpcCidr:       '10.0.0.0/16',
  subnets: {
    publicA:     '10.0.1.0/24',
    privateA:    '10.0.2.0/24',
    haA:         '10.0.3.0/24',
    mgmtA:       '10.0.4.0/24',   // port4 HA-management (public, per-unit EIP) — Fortinet 8.0 ref
    publicB:     '10.0.11.0/24',
    privateB:    '10.0.12.0/24',
    haB:         '10.0.13.0/24',
    mgmtB:       '10.0.14.0/24',  // port4 HA-management (public, per-unit EIP) — Fortinet 8.0 ref
  },
  instanceType:  'c6in.xlarge',
  bastionInstanceType: 't3.micro',   // in-VPC vantage to validate Port2 reachability
  clusterTag:    'fortigate-ha',
  ebsGb:         30,
  haPriorities:  { active: 200, passive: 100 },
  haPort:        703,
  failoverTimeout:      120,  // seconds — failover detection NFR
  labTimeoutMinutes:     30,  // minutes — EventBridge schedule (watchdog)
  lambdaTimeoutSeconds:  30,  // seconds — Lambda execution timeout (start CodeBuild build)
} as const;
