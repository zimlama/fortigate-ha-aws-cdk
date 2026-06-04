#!/usr/bin/env bash
# ha-test.sh — Terminate the Active FortiGate and run the failover validator.
#
# Expects:
#   - CDK stacks already deployed (FortiGateStack)
#   - Validator built at validator/dist/cli/run-validation.js
#   - AWS_PROFILE / AWS_REGION set in environment (inherited from deploy-and-test.sh)

set -euo pipefail

PROFILE="${AWS_PROFILE:-test-admin}"
REGION="${AWS_REGION:-us-east-1}"
CLUSTER_TAG="${CLUSTER_TAG:-fortigate-ha}"
POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-5000}"
POLL_TIMEOUT_MS="${POLL_TIMEOUT_MS:-120000}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ─── Locate the Active FortiGate instance ────────────────────────────────────
echo "==> Discovering Active FortiGate instance..."

ACTIVE_ID=$(
  AWS_PROFILE="${PROFILE}" aws ec2 describe-instances \
    --region "${REGION}" \
    --filters \
      "Name=tag:FortigateHACluster,Values=${CLUSTER_TAG}" \
      "Name=tag:ha-role,Values=active" \
      "Name=instance-state-name,Values=running" \
    --query "Reservations[0].Instances[0].InstanceId" \
    --output text 2>/dev/null
)

if [[ -z "${ACTIVE_ID}" || "${ACTIVE_ID}" == "None" ]]; then
  echo "ERROR: Could not find a running FortiGate instance tagged ha-role=active."
  echo "       Make sure the cluster is healthy before running this test."
  exit 1
fi

echo "    Active node: ${ACTIVE_ID}"

# ─── Terminate the Active node ────────────────────────────────────────────────
echo "==> Terminating Active node (${ACTIVE_ID}) to trigger failover..."
AWS_PROFILE="${PROFILE}" aws ec2 terminate-instances \
  --region "${REGION}" \
  --instance-ids "${ACTIVE_ID}" \
  --output text > /dev/null

echo "    Instance termination initiated."
echo "    Waiting 10 s before starting validator polling..."
sleep 10

# ─── Run the hexagonal validator ─────────────────────────────────────────────
echo ""
echo "==> Running failover validator (timeout: $((POLL_TIMEOUT_MS / 1000))s)..."
node "${REPO_DIR}/validator/dist/cli/run-validation.js" \
  "${ACTIVE_ID}" \
  --poll-interval "${POLL_INTERVAL_MS}" \
  --poll-timeout  "${POLL_TIMEOUT_MS}" \
  --region        "${REGION}" \
  --cluster-tag   "${CLUSTER_TAG}"

# validator exits 0 on PASSED, 1 on FAILED — propagated automatically
