#!/usr/bin/env bash
# ha-test.sh — Terminate the Active FortiGate and run the failover validator
#              FROM INSIDE THE VPC (on the bastion) via SSM.
#
# The validator's MgmtReachabilityInvariant probes the active node's Port2 PRIVATE
# IP, which is only reachable from inside the VPC. So the validator runs on the
# bastion (BastionStack) — staged to S3 by deploy-and-test.sh and triggered here
# via SSM SendCommand. Termination stays a local AWS API call.
#
# Expects:
#   - CDK stacks already deployed; /tmp/fgt-outputs.json present (cdk --outputs-file)
#   - validator.tgz already uploaded to the bastion's S3 bucket
#   - AWS_PROFILE / AWS_REGION set in environment (inherited from deploy-and-test.sh)

set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
CLUSTER_TAG="${CLUSTER_TAG:-fortigate-ha}"
POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-5000}"
POLL_TIMEOUT_MS="${POLL_TIMEOUT_MS:-120000}"
OUTPUTS_FILE="${OUTPUTS_FILE:-/tmp/fgt-outputs.json}"

export AWS_PROFILE AWS_REGION="${REGION}"

# ─── Resolve bastion id + validator bucket from CDK outputs ───────────────────
BASTION_ID="${BASTION_ID:-$(node -e "console.log(require('${OUTPUTS_FILE}').BastionStack.BastionInstanceId)")}"
BUCKET="${BUCKET:-$(node -e "console.log(require('${OUTPUTS_FILE}').BastionStack.ValidatorBucketName)")}"

if [[ -z "${BASTION_ID}" || "${BASTION_ID}" == "undefined" ]]; then
  echo "ERROR: could not resolve BastionInstanceId from ${OUTPUTS_FILE}." >&2
  exit 1
fi

# ─── Locate the Active FortiGate instance ────────────────────────────────────
echo "==> Discovering Active FortiGate instance..."
ACTIVE_ID=$(
  aws ec2 describe-instances \
    --region "${REGION}" \
    --filters \
      "Name=tag:FortigateHACluster,Values=${CLUSTER_TAG}" \
      "Name=tag:FortigateHARole,Values=active" \
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
aws ec2 terminate-instances --region "${REGION}" --instance-ids "${ACTIVE_ID}" --output text > /dev/null
echo "    Termination initiated. Waiting 10 s before validating..."
sleep 10

# ─── Run the validator on the bastion (in-VPC) via SSM ────────────────────────
echo ""
echo "==> Running failover validator on bastion ${BASTION_ID} (in-VPC) via SSM..."

REMOTE_SCRIPT="set -e
cd /tmp
command -v node >/dev/null || dnf install -y nodejs
command -v tar  >/dev/null || dnf install -y tar
aws s3 cp s3://${BUCKET}/validator.tgz /tmp/validator.tgz --region ${REGION}
rm -rf /tmp/validator && mkdir -p /tmp/validator
tar xzf /tmp/validator.tgz -C /tmp/validator
cd /tmp/validator
AWS_REGION=${REGION} node dist/cli/run-validation.js ${ACTIVE_ID} \\
  --poll-interval ${POLL_INTERVAL_MS} \\
  --poll-timeout ${POLL_TIMEOUT_MS} \\
  --region ${REGION} \\
  --cluster-tag ${CLUSTER_TAG}"

PARAMS_FILE=$(mktemp)
node -e "const fs=require('fs');fs.writeFileSync('${PARAMS_FILE}',JSON.stringify({commands:[process.argv[1]]}))" "${REMOTE_SCRIPT}"

CMD_ID=$(
  aws ssm send-command \
    --region "${REGION}" \
    --instance-ids "${BASTION_ID}" \
    --document-name "AWS-RunShellScript" \
    --comment "FortiGate HA failover validation" \
    --timeout-seconds 600 \
    --parameters "file://${PARAMS_FILE}" \
    --query "Command.CommandId" --output text
)
rm -f "${PARAMS_FILE}"
echo "    SSM command: ${CMD_ID}"

# ─── Poll for completion ──────────────────────────────────────────────────────
STATUS="Pending"
while true; do
  STATUS=$(aws ssm get-command-invocation \
    --region "${REGION}" --command-id "${CMD_ID}" --instance-id "${BASTION_ID}" \
    --query "Status" --output text 2>/dev/null || echo "Pending")
  case "${STATUS}" in
    Success|Failed|Cancelled|TimedOut|Cancelling) break ;;
  esac
  sleep 5
done

# ─── Surface validator output + propagate exit code ───────────────────────────
INV=$(aws ssm get-command-invocation \
  --region "${REGION}" --command-id "${CMD_ID}" --instance-id "${BASTION_ID}")
echo ""
echo "--- validator stdout ---"
echo "${INV}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).StandardOutputContent||''))"
echo "--- validator stderr ---"
echo "${INV}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.error(JSON.parse(d).StandardErrorContent||''))"

# Clamp to a valid exit code: SSM uses ResponseCode -1 for TimedOut/Cancelled, and
# it may be null if the command never ran — both must surface as FAIL (not a bash error).
RC=$(echo "${INV}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d).ResponseCode;console.log(Number.isInteger(r)&&r>=0&&r<=255?r:1)})")
echo ""
echo "==> Validator exit code: ${RC} (SSM status: ${STATUS})"
exit "${RC}"
