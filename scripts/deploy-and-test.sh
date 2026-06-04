#!/usr/bin/env bash
# deploy-and-test.sh — FortiGate HA lab pipeline (30-min budget)
#
# Usage:
#   AWS_PROFILE=test-admin HA_PASSWORD=secret ./scripts/deploy-and-test.sh
#
# Env vars:
#   AWS_PROFILE   AWS credentials profile (default: test-admin)
#   AWS_REGION    AWS region (default: us-east-1)
#   ADMIN_CIDR    CIDR allowed for Port2 MGMT access (default: 0.0.0.0/0 — CHANGE THIS)
#   HA_PASSWORD   FortiGate HA cluster password (required)
#   SKIP_DESTROY  Set to any non-empty value to skip auto-destroy (debug mode)

set -euo pipefail

PROFILE="${AWS_PROFILE:-test-admin}"
REGION="${AWS_REGION:-us-east-1}"
ADMIN_CIDR="${ADMIN_CIDR:-0.0.0.0/0}"
SKIP_DESTROY="${SKIP_DESTROY:-}"

: "${HA_PASSWORD:?HA_PASSWORD is required — set it before running}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ─── Cleanup trap ────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "==> [cleanup] Destroying all stacks..."
  (
    cd "${REPO_DIR}/infra"
    AWS_PROFILE="${PROFILE}" AWS_REGION="${REGION}" \
      npx cdk destroy --all --force --ci 2>&1 || true
  )
  echo "==> [cleanup] Done."
}

if [[ -z "${SKIP_DESTROY}" ]]; then
  trap cleanup EXIT
else
  echo "⚠️  SKIP_DESTROY is set — stacks will NOT be auto-destroyed."
fi

# ─── Build validator ─────────────────────────────────────────────────────────
echo "==> [T+0] Building validator..."
(cd "${REPO_DIR}/validator" && npm ci --silent && npm run build 2>/dev/null || npx tsc)
echo "    Validator built."

# ─── Deploy stacks ───────────────────────────────────────────────────────────
echo ""
echo "==> [T+0] Deploying stacks (NetworkStack → FortiGateStack → WatchdogStack)..."
(
  cd "${REPO_DIR}/infra"
  npm ci --silent
  AWS_PROFILE="${PROFILE}" AWS_REGION="${REGION}" \
    npx cdk deploy --all \
      --require-approval never \
      -c adminCidr="${ADMIN_CIDR}" \
      -c haPassword="${HA_PASSWORD}" \
      --outputs-file /tmp/fgt-outputs.json
)
echo "    Deploy complete."

# ─── HA failover test ────────────────────────────────────────────────────────
echo ""
echo "==> [T+~10m] Running HA failover test..."
"${REPO_DIR}/scripts/ha-test.sh"

echo ""
echo "==> PIPELINE COMPLETE — FAILOVER PASSED ✅"
