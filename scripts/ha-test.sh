#!/usr/bin/env bash
# ha-test.sh — Prove FortiGate FGCP failover, with layered diagnostics.
#
# Flow:
#   1. PRE-FLIGHT GATE — SSH the Active over Port4 and assert a healthy 2-member
#      cluster BEFORE terminating anything. A failover test on a cluster that never
#      formed proves nothing and burns a full deploy cycle, so we fail fast here.
#   2. Terminate the Active to trigger failover.
#   3. Run the failover validator on the in-VPC bastion via SSM (it must reach the
#      active node's Port2 PRIVATE IP).
#   4. Capture diagnostics regardless of outcome:
#        - EC2 serial console output (FortiOS boot / license / config-apply)
#        - Live FortiOS HA + SDN state over SSH on Port4 (ground truth)
#        - CloudTrail: did awsd actually call AssociateAddress / ReplaceRoute?
#
# See docs/05-troubleshooting-ha-runbook.md for how to read the output.
#
# Expects:
#   - CDK stacks already deployed; /tmp/fgt-outputs.json present (cdk --outputs-file)
#   - validator.tgz already uploaded to the bastion's S3 bucket
#   - AWS_PROFILE / AWS_REGION / HA_PASSWORD set (inherited from deploy-and-test.sh)

set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
CLUSTER_TAG="${CLUSTER_TAG:-fortigate-ha}"
POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-5000}"
POLL_TIMEOUT_MS="${POLL_TIMEOUT_MS:-360000}"
OUTPUTS_FILE="${OUTPUTS_FILE:-/tmp/fgt-outputs.json}"

export AWS_PROFILE AWS_REGION="${REGION}"

# ─── Resolve bastion id + validator bucket from CDK outputs ───────────────────
BASTION_ID="${BASTION_ID:-$(node -e "console.log(require('${OUTPUTS_FILE}').BastionStack.BastionInstanceId)")}"
BUCKET="${BUCKET:-$(node -e "console.log(require('${OUTPUTS_FILE}').BastionStack.ValidatorBucketName)")}"

if [[ -z "${BASTION_ID}" || "${BASTION_ID}" == "undefined" ]]; then
  echo "ERROR: could not resolve BastionInstanceId from ${OUTPUTS_FILE}." >&2
  exit 1
fi

out() { node -e "try{console.log(require('${OUTPUTS_FILE}').$1||'')}catch(e){}" 2>/dev/null || true; }

# ─── Helper: run FortiOS CLI on a FortiGate over SSH, from the bastion via SSM ─
# $1 = FortiGate IP   $2 = FortiOS commands, '\n'-separated (no trailing 'exit')
# Echoes the captured FortiOS stdout. Best-effort; never aborts the caller.
# Uses SSH_ASKPASS (OpenSSH 8.7+ on AL2023 — no sshpass/EPEL) with admin/HA_PASSWORD.
fgt_ssh_via_bastion() {
  local ip="$1" cmds="$2" remote params cmdid status
  if [[ -z "${ip}" || "${ip}" == "None" ]]; then echo "(no IP provided)"; return 1; fi
  if [[ -z "${HA_PASSWORD:-}" ]]; then echo "(HA_PASSWORD unset — cannot SSH)"; return 1; fi

  remote="set +e
cat > /tmp/fgt_askpass.sh <<'AP'
#!/bin/sh
echo \"\$FGT_PASS\"
AP
chmod +x /tmp/fgt_askpass.sh
printf '${cmds}\\nexit\\n' | FGT_PASS='${HA_PASSWORD}' SSH_ASKPASS=/tmp/fgt_askpass.sh SSH_ASKPASS_REQUIRE=force setsid -w \
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 \
      -o NumberOfPasswordPrompts=1 -o PubkeyAuthentication=no -o HostKeyAlgorithms=+ssh-rsa \
      admin@${ip} 2>&1 || echo '(ssh to ${ip} failed)'"

  params=$(mktemp)
  node -e "const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({commands:[process.argv[1]]}))" "${remote}" "${params}"
  cmdid=$(aws ssm send-command --region "${REGION}" --instance-ids "${BASTION_ID}" \
    --document-name "AWS-RunShellScript" --comment "FGT SSH diagnostics" --timeout-seconds 120 \
    --parameters "file://${params}" --query "Command.CommandId" --output text 2>/dev/null || true)
  rm -f "${params}"
  if [[ -z "${cmdid}" || "${cmdid}" == "None" ]]; then echo "(SSM send-command failed)"; return 1; fi

  status="Pending"
  while true; do
    status=$(aws ssm get-command-invocation --region "${REGION}" \
      --command-id "${cmdid}" --instance-id "${BASTION_ID}" \
      --query "Status" --output text 2>/dev/null || echo "Pending")
    case "${status}" in Success|Failed|Cancelled|TimedOut|Cancelling) break ;; esac
    sleep 5
  done
  aws ssm get-command-invocation --region "${REGION}" \
    --command-id "${cmdid}" --instance-id "${BASTION_ID}" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).StandardOutputContent||''))"
}

# ─── #1 PRE-FLIGHT GATE: prove a 2-member cluster BEFORE terminating anything ──
ACT_P4=$(out "FortiGateStack.FgtActivePort4Ip")
echo "==> [pre-flight] Verifying a healthy 2-member HA cluster before failover..."
if [[ -n "${HA_PASSWORD:-}" && -n "${ACT_P4}" ]]; then
  PF_OUT=$(fgt_ssh_via_bastion "${ACT_P4}" 'get system ha status\ndiagnose sys ha checksum cluster' || true)
  echo "${PF_OUT}"
  if echo "${PF_OUT}" | grep -q "number of member: 2"; then
    echo "    Pre-flight OK: 2-member cluster confirmed. Proceeding with failover test."
  else
    echo ""
    echo "ERROR: HA cluster is NOT a healthy 2-member cluster — ABORTING before termination."
    echo "       This is a cluster-formation fault, NOT a failover fault."
    echo "       Nothing was terminated; no failover was attempted."
    echo "       Triage: docs/05-troubleshooting-ha-runbook.md §4.A (heartbeat / sg-ha)."
    exit 2
  fi
else
  echo "    (skipping pre-flight: HA_PASSWORD or FgtActivePort4Ip unavailable — proceeding)"
fi

# ─── Locate the Active FortiGate instance ────────────────────────────────────
echo ""
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

# ─── Diagnostic capture: EC2 serial console output (always) ───────────────────
# Zero-cost local EC2 API call. Shows FortiOS boot, license activation, and whether
# `config system ha` / `config system sdn-connector` applied. Boot-only — pairs with
# the live SSH capture below for runtime state.
echo ""
echo "==> Capturing FortiGate serial console output (FortiOS boot + HA/SDN config)..."
RUNNING_FGT_IDS=$(
  aws ec2 describe-instances \
    --region "${REGION}" \
    --filters \
      "Name=tag:FortigateHACluster,Values=${CLUSTER_TAG}" \
      "Name=instance-state-name,Values=running" \
    --query "Reservations[].Instances[].InstanceId" \
    --output text 2>/dev/null || true
)
if [[ -z "${RUNNING_FGT_IDS}" ]]; then
  echo "    (no running cluster members found to capture)"
else
  for IID in ${RUNNING_FGT_IDS}; do
    echo ""
    echo "─── console: ${IID} (surviving / now-active node) ─────────────────────────"
    aws ec2 get-console-output \
      --region "${REGION}" --instance-id "${IID}" \
      --query "Output" --output text 2>/dev/null | tail -n 150 \
      || echo "    (console output not available yet for ${IID})"
  done
fi
echo "────────────────────────────────────────────────────────────────────────────"

# ─── #2 Diagnostic capture: live FortiOS HA/SDN state over SSH (always) ───────
# Ground truth for FGCP. Reaches the SURVIVING unit's Port4 HA-MGMT (always up,
# FGCP-independent) with Port2 as fallback, and dumps the full HA + SDN picture.
if [[ -n "${HA_PASSWORD:-}" ]]; then
  echo ""
  echo "==> Capturing live FortiOS HA/SDN diagnostics over SSH (via bastion)..."
  SURV_P4=$(aws ec2 describe-instances --region "${REGION}" \
    --filters "Name=tag:FortigateHACluster,Values=${CLUSTER_TAG}" \
              "Name=instance-state-name,Values=running" \
    --query "Reservations[0].Instances[0].NetworkInterfaces[?Attachment.DeviceIndex==\`3\`].PrivateIpAddress | [0]" \
    --output text 2>/dev/null || true)
  SURV_P2=$(aws ec2 describe-instances --region "${REGION}" \
    --filters "Name=tag:FortigateHACluster,Values=${CLUSTER_TAG}" \
              "Name=instance-state-name,Values=running" \
    --query "Reservations[0].Instances[0].NetworkInterfaces[?Attachment.DeviceIndex==\`1\`].PrivateIpAddress | [0]" \
    --output text 2>/dev/null || true)

  # Full FGCP picture: membership/primary, failover event history, config-sync
  # checksums, SDN connector (awsd) status, heartbeat NIC counters, port states.
  DIAG_CMDS='get system ha status\ndiagnose sys ha history read\ndiagnose sys ha checksum cluster\ndiagnose test application awsd 1\ndiagnose hardware deviceinfo nic port3\nget system interface physical'

  echo "    Surviving node Port4=${SURV_P4}  Port2=${SURV_P2}"
  echo ""
  echo "===== FortiOS diagnostics via Port4 HA-MGMT (${SURV_P4}) ====="
  fgt_ssh_via_bastion "${SURV_P4}" "${DIAG_CMDS}" || true
  echo ""
  echo "===== FortiOS diagnostics via Port2 fallback (${SURV_P2}) ====="
  fgt_ssh_via_bastion "${SURV_P2}" 'get system ha status' || true
  echo "────────────────────────────────────────────────────────────────────────────"
fi

# ─── #3 Diagnostic capture: CloudTrail — did awsd attempt the EIP/route move? ──
# Local API call, no added infra (management events are on by default). Proves
# whether the FortiGate role actually called AssociateAddress / ReplaceRoute and
# what AWS returned (errorCode). NOTE: CloudTrail can lag up to ~15 min, so a
# fast test may show no events yet — absence here is not proof of inaction.
echo ""
echo "==> CloudTrail: EIP/route API calls in the last 30 min (did failover fire?)..."
CT_START=$(date -u -v-30M '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d '30 minutes ago' '+%Y-%m-%dT%H:%M:%SZ')
for EV in AssociateAddress DisassociateAddress ReplaceRoute; do
  echo "  --- ${EV} ---"
  aws cloudtrail lookup-events --region "${REGION}" \
    --lookup-attributes "AttributeKey=EventName,AttributeValue=${EV}" \
    --start-time "${CT_START}" --max-results 15 \
    --query "Events[].CloudTrailEvent" --output json 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{let a=[];try{a=JSON.parse(d)}catch(_){}if(!a.length){console.log('      (none in window — CloudTrail can lag ~15 min)');return}a.forEach(s=>{try{const e=JSON.parse(s);const who=(e.userIdentity&&(e.userIdentity.arn||e.userIdentity.type))||'?';console.log('      '+e.eventTime+'  by='+who+'  src='+(e.sourceIPAddress||'?')+(e.errorCode?('  ERROR='+e.errorCode+': '+(e.errorMessage||'')):'  OK'))}catch(_){}})})" \
    || echo "      (lookup failed)"
done
echo "────────────────────────────────────────────────────────────────────────────"

# ─── Debug hints on failure ───────────────────────────────────────────────────
if [[ "${RC}" -ne 0 ]]; then
  ACTIVE_PORT4=$(out "FortiGateStack.FgtActivePort4Ip")
  PASSIVE_PORT4=$(out "FortiGateStack.FgtPassivePort4Ip")
  echo ""
  echo "─── Manual SSH debug (requires SKIP_DESTROY=1 to keep stacks alive) ─────────"
  echo "  Open bastion shell:"
  echo "    aws ssm start-session --target ${BASTION_ID} --region ${REGION} --profile ${PROFILE}"
  echo "  Then from the bastion (admin password = HA_PASSWORD), prefer Port4 HA-MGMT:"
  [[ -n "${ACTIVE_PORT4}" ]]  && echo "    ssh admin@${ACTIVE_PORT4}   # was active (now terminated)"
  [[ -n "${PASSIVE_PORT4}" ]] && echo "    ssh admin@${PASSIVE_PORT4}  # surviving — should be primary"
  echo "  FortiOS: get system ha status            # expect 'number of member: 2' pre-failover"
  echo "  FortiOS: diagnose test application awsd 1 # AWS SDN connector status"
  echo "  Full triage: docs/05-troubleshooting-ha-runbook.md"
  echo "────────────────────────────────────────────────────────────────────────────"
fi

exit "${RC}"
