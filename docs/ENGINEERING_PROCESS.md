# Engineering Process — How this repo evolves

> **Audience**: Anyone contributing to the repo, or evaluating it as a portfolio piece.
>
> **Last updated**: 2026-06-10.

This document captures the **engineering process** that produced this project,
so the next change follows the same shape — and so a reviewer can see the
journey from `v1.0.0` to `v1.1.0` and beyond, not just the diff.

---

## 1. Branching model

The repo uses a **git-flow-style** model with two long-lived branches and three
families of short-lived ones.

```
master              — Producción (stable, tagged versions)
  ├── fix/*         — Hotfixes (rápidos, críticos)         → PR a master
  ├── feature/*     — Features (trabajo en progreso)       → PR a developer
  └── developer     — Integración (pre-producción)
      ├── refactor/* — Refactorings
      └── docs/*     — Documentación
```

| Branch | Purpose | Lifetime | Updated by |
|---|---|---|---|
| `master` | **Default branch.** The validated, deployable baseline. Tagged with `vX.Y.Z`. | Permanent | PR merges from `developer` and `fix/*` |
| `developer` | **Integration branch.** Pre-production. All feature/refactor/docs work lands here first. | Permanent | PR merges from `feature/*`, `refactor/*`, `docs/*` |
| `feature/<name>` | A unit of new functionality. | Deleted after merge to `developer` | Direct commits, force-push OK |
| `refactor/<name>` | A code change with no functional change. | Deleted after merge to `developer` | Direct commits, force-push OK |
| `docs/<name>` | Documentation-only change. | Deleted after merge to `developer` | Direct commits, force-push OK |
| `fix/<name>` | Hotfix that can't wait for the normal flow. PR goes **directly to `master`**. | Deleted after merge | Direct commits, force-push OK |
| `legacy/<version>` | An immutable snapshot of a past release. | Permanent, never updated | `git branch legacy/v1-initial <sha>` |

### Why two long-lived branches

- **`master` is always deployable.** A reviewer can clone `master`, run
  `npm ci && npm test`, and have a working, validated lab. No "trust me, it
  works on my machine" — the deploy run-log proves it.
- **`developer` is the integration buffer.** Features land here, get tested
  together, and only when the integration is green do they get promoted to
  `master`. This matches the `git-flow` model and gives a stable branch to
  base a hotfix off of.
- **`legacy/` preserves evolution.** Instead of rewriting history (which would
  break anyone who cloned previously), we keep `legacy/v1-initial` as a frozen
  snapshot. The diff between `legacy/v1-initial` and `master` is the v1 → v1.1
  story.

### What we don't do

- ❌ No squash-merges to `master` or `developer`. Linear history is intentional
  — each commit tells a story. Squash-merge is allowed for `feature/*` →
  `developer` only when the feature is a single self-contained unit.
- ❌ No force-pushes to `master` or `developer`. Only to `feature/*`, `refactor/*`,
  `docs/*`, and `fix/*`.

### CI triggers

The GitHub Actions workflow at `.github/workflows/ci.yml` runs on every push
and pull_request targeting `master` or `developer`. It runs:

- `npm ci`
- `npx tsc --noEmit` (typecheck)
- `npm run test:coverage` (validator, with the ≥90% branch coverage gate)
- `npm test` (CDK assertion tests)

See [`docs/OPERATIONS.md` §2](./OPERATIONS.md#2-clone-install-verify-no-aws-needed)
for the equivalent local command sequence.

---

## 2. PR workflow

Every change goes through a PR, even docs. The PR is the unit of review and the
unit of traceability.

```
feature/<name>  ──PR──▶  master  ──tag──▶  vX.Y.Z
                       (default)
                       (deployable)
```

### Conventions for PR titles and bodies

- **Title**: Conventional commits. `feat:`, `fix:`, `docs:`, `refactor:`,
  `chore:`, `test:`. Scope is optional but encouraged: `fix(ha):`.
- **Body**: Context → change → validation. Include:
  - **Why** — what motivated the change (bug, feature, post-mortem).
  - **What** — the diff at a high level.
  - **Validation** — how you know it works. For infra: deploy + failover run.
    For docs: spell-check + read-through.
  - **Refs** — related issues, ADRs, lessons-learned entries.

### The narrative-commit pattern

When merging a feature into `master` and the fix is already in `master` (e.g.
during a rebase or when the feature was applied directly to `master` first), the
PR would have a tree-equivalent diff. To preserve PR visibility, add a
**narrative commit** on `master` that documents the integration:

```
master
├── 8177fbb docs: add CHANGELOG.md and ADR 0001
├── 022be91 feat(ha): integrate heartbeat fix from feature/heartbeat-fix   ← narrative
├── c52a321 fix(ha): unblock FGCP failover (heartbeat SG) + diagnostics
├── a99b488 fix(fortigate): attach all 4 ENIs at instance launch
└── ...
```

The narrative commit (`022be91` above) is **tree-equivalent** with `master~1`
but advances the SHA, making the PR visible in GitHub's PR list. The commit
body should:

- Reference the original feature branch.
- Explain why a separate integration commit was chosen over a merge commit.
- Link to the validation evidence (CloudTrail, deploy log).

This is the pattern used for the v1.0.0 → v1.1.0 integration; we expect to
reuse it for future releases.

---

## 3. CHANGELOG discipline

Every release that ships to `master` MUST update `CHANGELOG.md`. Format:
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

### What goes in a release entry

- **Added** — new user-visible features.
- **Changed** — changes to existing behaviour.
- **Fixed** — bug fixes.
- **Lessons** — pointer to `lessons-learned.md` for the post-mortem (not the
  full text).
- **Known limitations** — what is still broken, scheduled for the next release.

### Versioning

[Semantic Versioning 2.0.0](https://semver.org/):

- `MAJOR` (1.x.x → 2.x.x) — incompatible architecture change.
- `MINOR` (x.1.x → x.2.x) — new feature, backward-compatible.
- `PATCH` (x.x.1 → x.x.2) — bug fix, backward-compatible.

The project started at `v1.0.0` (initial deployable) and is now at `v1.1.0`
(heartbeat fix). Future planned releases:

- `v1.2.0` — Port4 HA-MGMT outputs as CloudFormation exports (was added in `1.1.0` but not exported).
- `v2.0.0` — if/when the project moves off CDK and onto Terraform (decision pending).

### Tagging

```bash
git tag -a vX.Y.Z <branch> -m "vX.Y.Z — <one-line summary>"
git push origin --tags
```

Annotated tags only. Lightweight tags (`git tag vX.Y.Z`) are not allowed —
they don't survive a `git push --follow-tags` cleanly.

---

## 4. ADRs (Architecture Decision Records)

ADRs capture the **why** of a non-obvious decision so a future engineer
(including future-you) doesn't re-litigate it. Format:
[Michael Nygard](http://thinkrelevance.com/blog/2011/11/15/documenting-architecture-decisions).

### File layout

```
docs/ADR/
├── 0001-fgcp-heartbeat-self-referencing-sg.md
├── 0002-<future-decision>.md
└── README.md (index of all ADRs)
```

Numbering is **monotonically increasing, never reused**. Even rejected
decisions get an ADR with `Status: Rejected` so the alternatives are visible.

### When to write an ADR

- The decision is **non-obvious** — a future engineer would not arrive at the
  same choice without context.
- The decision is **hard to reverse** — a security group, IAM policy, schema,
  API contract.
- The decision is **contentious** — there were real alternatives considered.

### When NOT to write an ADR

- Routine implementation details (variable names, file layout).
- Decisions already covered by an ADR (link, don't duplicate).
- Decisions that are easy to reverse (refactors).

The first ADR is `0001-fgcp-heartbeat-self-referencing-sg.md`, which captures
the single most impactful decision in the project. Future ADRs will follow.

---

## 5. Lessons learned

Every failure, fix, and insight goes into `docs/lessons-learned.md` in
**Symptom → Tried → Worked → Why** format. The list is ordered by impact, not
chronology.

The 10 current lessons cover the full v1 → v1.1 journey, including the 4 most
costly mistakes (heartbeat SG, IAM red herrings, ENI attachment order, port 703
vs EtherType).

New lessons are added to the top, not the bottom. Existing lessons are
**never rewritten** — if a lesson needs updating, mark it as superseded and
write a new one.

---

## 6. The end-to-end flow (worked example: v1.0.0 → v1.1.0)

This is the exact sequence that produced the v1.1.0 release. Use it as a
template for future releases.

### 1. Branch for the work

```bash
git checkout master
git checkout -b feature/heartbeat-fix
```

### 2. Make the change

- Modify the code (`infra/lib/network-stack.ts` for the SG fix).
- Update the tests (`infra/test/network-stack.test.ts`).
- Update `docs/lessons-learned.md` with a new entry.
- Add diagrams to `docs/diagrams/` if needed.

### 3. Validate locally

```bash
(cd infra     && npm ci && npm test)
(cd validator && npm ci && npm test)
```

### 4. Deploy to a real AWS account and run the failover test

```bash
AWS_PROFILE=<profile> AWS_REGION=us-east-1 \
  HA_PASSWORD='<secret>' \
  ./scripts/deploy-and-test.sh
```

This is **mandatory** for any infra change. CDK tests cover unit-level
assertions, but only a real deploy + real failover proves the integration.

### 5. Commit and push

```bash
git add -A
git commit -m "fix(ha): unblock FGCP failover (heartbeat SG) and add layered diagnostics

Root cause: sg-ha was scoped to TCP/UDP 703 (session-sync), which drops
the FGCP heartbeat (protocol-level EtherType packets). The cluster never
formed (number of member: 1) so the EIP never migrated.

Validation: deploy-and-test.sh, PIPELINE COMPLETE — FAILOVER PASSED.
CloudTrail: AssociateAddress by new instance role i-0b36..."
git push -u origin feature/heartbeat-fix
```

### 6. Open the PR

```bash
gh pr create --base master --head feature/heartbeat-fix \
  --title "fix(ha): FGCP heartbeat self-referencing SG unblocks failover" \
  --body-file .github/PULL_REQUEST_TEMPLATE.md
```

### 7. Write the ADR

Capture the decision in `docs/ADR/NNNN-<slug>.md` while the context is fresh.

### 8. Update CHANGELOG.md

Add a new section at the top with the version, date, Fixed/Changed/Added/Lessons.

### 9. Tag the release

```bash
git tag -a vX.Y.Z master -m "vX.Y.Z — <one-line summary>"
git push origin --tags
```

### 10. Preserve the v1 snapshot (if this is a major version)

```bash
git branch legacy/v<X+1>-initial master~<N>   # where <N> is the number of commits in the v1
git push -u origin legacy/v<X+1>-initial
git tag -a v<X+1>.0.0 legacy/v<X+1>-initial -m "v<X+1>.0.0 — <summary>"
git push origin --tags
```

---

## 7. The 30-second pitch (for portfolio / interview)

> "This project deploys FortiGate Active-Passive HA on AWS and **proves** that
> failover works end-to-end — by actually terminating the active node and
> confirming the surviving unit re-associates the WAN EIP on poll #1. The
> validator is hexagonal: pure-TypeScript domain with no AWS SDK imports, so
> the test suite runs in milliseconds with zero mocks. The first version
> failed at the failover step due to a heartbeat security-group misconfig; the
> fix is documented as an ADR, the post-mortem is in lessons-learned, and the
> full v1 → v1.1 evolution is visible in the git log and CHANGELOG. The lab
> auto-destroys on exit so each run costs ~$1.50."
