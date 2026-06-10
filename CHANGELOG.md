# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] — 2026-06-09

### Fixed
- **FGCP Active-Passive failover unblocked.** The HA heartbeat security group (`sg-ha`) was scoped to TCP/UDP 703, which dropped protocol-level FGCP heartbeat packets. The cluster never formed (`number of member: 1`), so failover could not occur. Replaced with a self-referencing `sg-ha` that allows all traffic between cluster members.
- **First-poll EIP migration.** With the cluster now forming, the surviving unit re-associates the WAN EIP on poll #1 (< 10s after Active termination).
- **Diagnostic path over Port4 (HA Management).** The bastion can now SSH to the FortiOS CLI on Port4 for in-VPC diagnostics; `get system ha status`, `get system performance status`, and `diagnose sys ha checksum show` are all reachable.

### Added
- **Layered diagnostics in `ha-test.sh`.** Pre-flight 2-member gate; FortiOS diagnostics over Port4; CloudTrail capture of `AssociateAddress` / `DisassociateAddress` / `ReplaceRoute` API calls in the last 30 min.
- **Persisted run log in `deploy-and-test.sh`.** Full pipeline output is now tee'd to `/tmp/fgt-ha-run-YYYYMMDD-HHMMSS.log` so post-mortems survive the auto-destroy trap.
- **IAM permissions expanded.** `ec2:Describe*` and `ec2:DisassociateAddress` granted to the FortiGate instance role so the FGCP failover callback can re-associate the WAN EIP.
- **Troubleshooting runbook** (`docs/05-troubleshooting-ha-runbook.md`) and **CDK preflight design checklist** (`docs/06-cdk-preflight-design-checklist.md`).

### Changed
- **`sg-ha` ingress rule** changed from `TCP/UDP 703` to a self-referencing `ALL TRAFFIC` rule with source = `sg-ha` itself.
- **`ha-test.sh`** is now a layered, exit-gated script (pre-flight → inject → poll → capture) instead of a single SSH-and-pray call.

### Lessons
See `docs/lessons-learned.md` for the full post-mortem (lessons #8–#10 added in this release).

---

## [1.0.0] — 2026-06-08

### Added
- **Initial FortiGate Active/Passive HA lab on AWS via CDK TypeScript.** 3 stacks (Network, FortiGate, Bastion) plus a Watchdog Lambda for cost protection.
- **Two-AZ topology** with 4 ENIs per FortiGate (port1 WAN, port2 internal, port3 HA heartbeat, port4 HA Management) mirroring the Fortinet 8.0 reference design.
- **Hexagonal failover validator** (`validator/`) — pure TypeScript domain with no AWS SDK imports, ≥90% coverage, 20 tests passing.
- **CDK fine-grained assertion tests** (`infra/test/`) — 24 tests covering SG rules, IAM, ENI attachments, EIP associations, and route tables.
- **Auto-destroy trap** in `scripts/deploy-and-test.sh` — stacks self-destruct on script exit unless `SKIP_DESTROY` is set. Cost guard: ~$1.50 per 30-min lab run.
- **PRD, RFC, HLD, LLD** in `docs/00–03`.
- **Cost analysis** (`docs/cost-analysis.md`) — FortiGate PAYG vs. AWS-native (Network Firewall + S2S VPN + TGW).

### Known limitations (fixed in 1.1.0)
- ❌ FGCP failover failed in validation. Cluster never formed due to heartbeat SG misconfiguration.
- ❌ No diagnostic path to FortiOS — failures were black-box.
- ❌ No persisted logs — auto-destroy wiped evidence.
