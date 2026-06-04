export const defaults = {
  vpcCidr:       '10.0.0.0/16',
  subnets: {
    publicA:     '10.0.1.0/24',
    privateA:    '10.0.2.0/24',
    haA:         '10.0.3.0/24',
    publicB:     '10.0.11.0/24',
    privateB:    '10.0.12.0/24',
    haB:         '10.0.13.0/24',
  },
  instanceType:  'c6in.xlarge',
  ebsGb:         30,
  haPriorities:  { active: 200, passive: 100 },
  haPort:        703,
  failoverTimeout: 120,   // seconds (NFR)
  labTimeout:    30,      // minutes (watchdog)
} as const;
