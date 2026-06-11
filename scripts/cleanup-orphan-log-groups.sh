#!/usr/bin/env bash
# cleanup-orphan-log-groups.sh — Delete CloudWatch Log Groups left over
# by the BastionStack Custom Resource after deploy-and-test.sh destroys
# the stacks.
#
# Background: CDK's `s3.Bucket({ autoDeleteObjects: true })` creates a
# Custom Resource Lambda whose LogGroup has no retention. When the
# BastionStack is destroyed, the log group is NOT deleted — it
# accumulates forever. Each deploy-and-test run creates a new log
# group with a random suffix.
#
# This script finds and deletes all log groups that match the
# `BastionStack-CustomS3AutoDeleteObjects*` prefix in us-east-1.
# The /aws/lambda/account-guardian log group is NOT touched.
#
# Usage:
#   AWS_PROFILE=default ./scripts/cleanup-orphan-log-groups.sh [--dry-run]

set -euo pipefail

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
DRY_RUN=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="--dry-run" ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

echo "==> Profile: ${PROFILE} | Region: ${REGION}"
echo ""

# Find all log groups with the BastionStack Custom Resource prefix.
LOG_GROUPS=$(aws --profile "${PROFILE}" --region "${REGION}" \
  logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/BastionStack-CustomS3AutoDeleteObjects" \
  --query 'logGroups[].logGroupName' \
  --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)

if [[ -z "${LOG_GROUPS}" ]]; then
  echo "==> No orphan BastionStack log groups found. Nothing to clean up."
  exit 0
fi

COUNT=$(echo "${LOG_GROUPS}" | wc -l | tr -d ' ')
echo "==> Found ${COUNT} orphan log group(s):"
echo "${LOG_GROUPS}" | sed 's/^/    /'
echo ""

if [[ -n "${DRY_RUN}" ]]; then
  echo "==> DRY RUN: not deleting. Re-run without --dry-run to actually delete."
  exit 0
fi

echo "==> Deleting..."
DELETED=0
FAILED=0
for LG in ${LOG_GROUPS}; do
  if aws --profile "${PROFILE}" --region "${REGION}" \
      logs delete-log-group --log-group-name "${LG}" 2>/dev/null; then
    DELETED=$((DELETED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "    FAILED: ${LG}"
  fi
done

echo ""
echo "==> Done. Deleted: ${DELETED} | Failed: ${FAILED}"
echo "==> Remaining BastionStack log groups:"
aws --profile "${PROFILE}" --region "${REGION}" \
  logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/BastionStack-CustomS3AutoDeleteObjects" \
  --query 'logGroups[].[logGroupName,storedBytes,retentionInDays]' \
  --output text 2>/dev/null | sed 's/^/    /'
echo "(should be empty)"
