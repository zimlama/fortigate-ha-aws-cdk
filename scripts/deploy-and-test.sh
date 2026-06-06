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

PROFILE="${AWS_PROFILE:-default}"
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

# ─── Build + package validator ────────────────────────────────────────────────
# The validator runs on the in-VPC bastion (it must reach the active FortiGate's
# Port2 PRIVATE IP). Package dist + node_modules so the bastion only needs Node.
VALIDATOR_TGZ="/tmp/fgt-validator.tgz"
echo "==> [T+0] Building + packaging validator..."
(cd "${REPO_DIR}/validator" && npm ci --silent && npm run build 2>/dev/null || npx tsc)
tar czf "${VALIDATOR_TGZ}" -C "${REPO_DIR}/validator" dist node_modules package.json
echo "    Validator built and packaged (${VALIDATOR_TGZ})."

# ─── Deploy stacks ───────────────────────────────────────────────────────────
echo ""
echo "==> [T+0] Deploying stacks (NetworkStack → FortiGateStack → BastionStack → WatchdogStack)..."
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

# ─── Upload validator artifact to the bastion's S3 bucket ─────────────────────
BUCKET=$(node -e "console.log(require('/tmp/fgt-outputs.json').BastionStack.ValidatorBucketName)")
echo ""
echo "==> Uploading validator to s3://${BUCKET}/validator.tgz ..."
AWS_PROFILE="${PROFILE}" aws s3 cp "${VALIDATOR_TGZ}" "s3://${BUCKET}/validator.tgz" --region "${REGION}"
echo "    Upload complete."

# ─── Wait for FortiGate to boot and establish HA heartbeat ───────────────────
# CDK deploy completes when EC2 state = "running", but FortiGate VM needs
# ~5 min more to: boot FortiOS, apply UserData config, and establish the FGCP
# unicast heartbeat with the peer. Testing before HA is up = no failover occurs.
HA_BOOT_WAIT="${HA_BOOT_WAIT:-420}"
echo ""
echo "==> Waiting ${HA_BOOT_WAIT}s for FortiGate HA to boot and establish heartbeat..."
sleep "${HA_BOOT_WAIT}"
echo "    Wait complete."

# ─── HA failover test ────────────────────────────────────────────────────────
echo ""
echo "==> [T+~10m] Running HA failover test..."
"${REPO_DIR}/scripts/ha-test.sh"

echo ""
echo "==> PIPELINE COMPLETE — FAILOVER PASSED ✅"
