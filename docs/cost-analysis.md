# Cost Analysis — FortiGate HA vs AWS-Native Secure Edge

> Real pricing: AWS Price List API + AWS Marketplace software listing (us-east-1, On-Demand),
> retrieved 2026-06-04. **Apples-to-apples secure-edge comparison** — both options provide
> site-to-site VPN termination **and** traffic inspection, the two functions a FortiGate cluster
> performs. Both sized as **2-AZ HA** (the deployed design).

---

## TL;DR — FortiGate PAYG is a premium, not a saving

With the **confirmed** FortiGate-VM PAYG software rate (~$1.02/hr/instance on the recommended
`c6in.xlarge`), FortiGate HA does **not** beat AWS-native on raw cost within any realistic
deployment size:

| Sites | AWS-native 2-AZ /mo | FortiGate HA /mo (flat) | Cheaper |
|------:|--------------------:|------------------------:|---------|
| 1     | ~$686               | ~$1,829                 | **AWS-native** |
| 5     | ~$978               | ~$1,829                 | **AWS-native** |
| 10    | ~$1,343             | ~$1,829                 | **AWS-native** |
| 17    | ~$1,854             | ~$1,829                 | FortiGate (break-even) |

**Crossover ≈ 17 sites.** Below it (the entire lab / SMB / mid-market range) AWS-native is
cheaper. FortiGate's AWS cost is **flat** — one HA pair terminates every tunnel — so its
advantage only appears at large hub-and-spoke scale.

The architect's takeaway: **you don't choose FortiGate PAYG to save money.** You choose it for
the NGFW feature set (IPS, app control, SSL inspection, FortiManager/FortiAnalyzer ecosystem)
and a single-vendor operational model. The cost-competitive FortiGate path is **BYOL**, which
removes the per-hour software charge and flips the comparison (see sensitivity). Stating this
honestly is what separates a senior cost analysis from a vendor pitch.

---

## Methodology & data sources

- **Region:** us-east-1. **Pricing model:** On-Demand, Linux, shared tenancy. **730 hr/month.**
- **Instance:** `c6in.xlarge` (4 vCPU / 8 GiB) — Fortinet's documented *recommended default* for
  FortiGate-VM on AWS, and the smallest dimension offered in the PAYG Marketplace listing.
- **Sources:** AWS Price List API via `aws-pricing` MCP (EC2/VPC/NFW SKUs); AWS Marketplace
  listing for the Fortinet PAYG software rate (not exposed by the Price List API).

### Unit price reference (real data, us-east-1)

| Component | Unit | Price (USD) | Source / note |
|---|---|---|---|
| EC2 `c6in.xlarge` (4 vCPU / 8 GiB) | hour | **$0.2268** | AmazonEC2 · SKU `2HC4SEQ26EXUUNAY` |
| FortiGate-VM PAYG software (`c6in.xlarge`) | hour | **~$1.02** | AWS Marketplace listing (confirm per FortiOS version) |
| EBS `gp3` | GB-month | $0.0800 | `EBS:VolumeUsage.gp3` |
| Public IPv4 (in-use) | hour | $0.0050 | `VPCPublicIPv4Address` |
| Data transfer OUT (first paid tier) | GB | $0.0900 | `DataTransfer-Out-Bytes` |
| Site-to-Site VPN connection | hour | $0.0500 | `VPN-Usage-Hours:ipsec.1` |
| Transit Gateway attachment | hour | $0.0500 | `USE1-TransitGateway-Hours` |
| Network Firewall endpoint | hour | $0.3950 | `USE1-Endpoint-Hour` |
| Network Firewall data processing | GB | $0.0650 | `USE1-Traffic-GB-Processed` |

> The **software rate dominates** every figure below. EC2 is ~18% of the FortiGate hourly cost;
> the Fortinet PAYG license is ~82%.

---

## Lens 1 — Lab cost per run (ephemeral, 30 min)

A run is 0.5 h of the 2-instance HA pair (deploy → failover test → auto-destroy):

| Item | Calculation | Cost |
|---|---|---:|
| 2× c6in.xlarge EC2 | 2 × $0.2268 × 0.5 | $0.2268 |
| 2× FortiGate PAYG software | 2 × $1.02 × 0.5 | $1.0200 |
| EBS gp3 (60 GB) | $4.80/mo ÷ 730 × 0.5 | $0.0033 |
| Public IPv4 (1 EIP) | $0.0050 × 0.5 | $0.0025 |
| Data transfer (~1 GB lab) | 1 × $0.0900 | $0.0900 |
| **Total per run** | | **≈ $1.34** |

Within the **revised < $2/run NFR** (the original < $1 target is not achievable with PAYG
`c6in.xlarge` — the software rate alone is ~$1.02/run). A **BYOL** lab would be ~$0.32/run and
fit under $1; an option if many iterations are expected.

---

## Lens 2 — Monthly production TCO + crossover curve

Hub-and-spoke with `N` remote sites; both options run **VPN termination + inspection** in
**2 AZs** for HA.

### FortiGate HA — flat (one HA pair terminates all tunnels)

| Item | Monthly |
|---|---:|
| 2× c6in.xlarge EC2 (24/7) | $331.13 |
| 2× FortiGate-VM PAYG software | $1,489.20 |
| EBS gp3 (60 GB) | $4.80 |
| Public IPv4 (1 migrating EIP) | $3.65 |
| **Subtotal (ex data transfer)** | **≈ $1,828.78** |

Independent of `N` — an extra site is another IPSec tunnel on the *same* pair, no incremental
AWS charge.

### AWS-native secure edge — 2-AZ, scales per site

| Item | Type | Monthly |
|---|---|---:|
| Network Firewall endpoint × 2 AZ | fixed | $576.70 |
| Transit Gateway — VPC attachment | fixed | $36.50 |
| **Fixed subtotal** | | **$613.20** |
| Site-to-Site VPN connection | per site | $36.50 |
| TGW attachment (VPN) | per site | $36.50 |
| **Per-site subtotal** | | **$73.00** |

`Total = $613.20 + $73.00 × N` (+ data processing $0.065/GB NFW + $0.02/GB TGW, volume-dependent).
A single-AZ AWS-native deployment halves the firewall fixed cost (~$288/mo) but loses AZ
resilience — not apples-to-apples with FortiGate 2-AZ HA.

### Crossover

```
613.20 + 73.00 × N = 1,828.78
N* = (1,828.78 − 613.20) / 73.00 ≈ 16.7 sites
```

- **1–16 sites:** AWS-native cheaper.
- **≥ 17 sites:** FortiGate HA cheaper, advantage widening linearly.

### Sensitivity — the licensing model is the real lever

| Scenario | FortiGate flat /mo | Crossover |
|---|---:|---:|
| **PAYG `c6in.xlarge`** ($1.02/hr software) | $1,828.78 | ~17 sites |
| **BYOL** (no per-hour software) | ~$339.58 + license | **AWS-native never cheaper** (FortiGate < fixed $613 at N=1) |

BYOL removes the $1,489/mo software line entirely; FortiGate then sits *below* AWS-native's fixed
cost at a single site. The annual BYOL license fee (separate, not in the Price List API) is the
trade — amortized, it is far less than PAYG at 24/7. **For production, BYOL is the cost-rational
FortiGate choice; PAYG suits short-lived / bursty use like this lab.**

---

## Sizing review — why `c6in.xlarge`

FortiGate-VM vCPU tiers on AWS (Fortinet 7.6 AWS admin guide):

| Tier | Instance | vCPU / RAM | Verdict |
|---|---|---|---|
| Absolute minimum | t2.small | 1 / 2 GB | ❌ burstable, boots only — not for inspection |
| Practical minimum | c6i.large / c5.large | 2 / 4 GB | meets the 4 GB RAM floor; marginal with UTM on |
| **Recommended default** | **c6in.xlarge** | **4 / 8 GB** | ✅ Fortinet default; required for UTM / ZTNA / proxy |

Fortinet recommends **≥ 4 GB RAM**, "especially if UTM, ZTNA, or proxy is enabled," and lists
`c6in.xlarge` as *"recommended by default."* It is also the smallest PAYG dimension — so the
choice is validated on two independent grounds. Graviton (`c7g`/`c6gn`/`c8gn`) AMIs exist and run
~15% cheaper, but HA on Graviton has field reports of problems; not worth the risk for an
HA-centric project.

---

## Assumptions & open items

- FortiGate PAYG software ~$1.02/hr is from the Marketplace listing for `c6in.xlarge`; reconfirm
  for the exact FortiOS version/AMI before publishing a figure.
- 2-AZ both sides (matches the deployed HA design). Single-AZ would lower AWS-native fixed cost.
- Data-processing volumes excluded from the base curve; add per-GB once traffic is estimated.
- BYOL license fee is annual and out of the Price List API — model it separately if BYOL is chosen.
- EBS assumed 2× 30 GB gp3; refine to the actual FortiGate-VM disk layout.

---

## Conclusion

With confirmed pricing, the earlier "FortiGate ~36% cheaper" claim is **wrong for any realistic
size**: on PAYG `c6in.xlarge`, FortiGate HA (~$1,829/mo, flat) only undercuts AWS-native 2-AZ
(~$613 + $73/site) beyond **~17 sites**. The lab runs at **~$1.34** (within the revised < $2 NFR).
The model's *shape* (flat vs linear) is the durable insight; the licensing model (PAYG vs BYOL)
is the dominant lever — BYOL flips FortiGate to cheapest at any scale. Choose FortiGate for its
NGFW capability and single-vendor operations, and choose BYOL if cost is the driver — not PAYG.
