#!/usr/bin/env bash
# setup-account-guardian.sh — Deploy account-level cost guardian (run once, stays forever)
#
# Creates:
#   - AccountGuardianStack: Lambda + EventBridge rules (8PM and 5AM COT)
#   - AWS Budget: monthly $20 alert at 80% and 100%
#
# Usage:
#   AWS_PROFILE=test-admin ./scripts/setup-account-guardian.sh

set -euo pipefail

PROFILE="${AWS_PROFILE:-test-admin}"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws --profile "${PROFILE}" sts get-caller-identity --query Account --output text)
ALERT_EMAIL="${ALERT_EMAIL:-zimlama@gmail.com}"
BUDGET_LIMIT="${BUDGET_LIMIT:-20}"

echo "==> Account: ${ACCOUNT_ID} | Region: ${REGION}"
echo "==> Budget alert email: ${ALERT_EMAIL}"
echo ""

# ─── 1. Account Guardian Stack ───────────────────────────────────────────────
echo "==> [1/3] Deploying AccountGuardianStack..."

TEMPLATE=$(cat <<'YAML'
AWSTemplateFormatVersion: '2010-09-09'
Description: Account-level guardian — destroys lab stacks at 8PM and 5AM COT

Resources:

  GuardianRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: AccountGuardianRole
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/AdministratorAccess

  GuardianLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: /aws/lambda/account-guardian
      RetentionInDays: 7

  GuardianFn:
    Type: AWS::Lambda::Function
    DependsOn: GuardianLogGroup
    Properties:
      FunctionName: account-guardian
      Runtime: python3.12
      Handler: index.handler
      Role: !GetAtt GuardianRole.Arn
      Timeout: 900
      Code:
        ZipFile: |
          import boto3, os

          EXCLUDE = {'CDKToolkit', 'AccountGuardianStack'}

          TERMINAL = {
              'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'ROLLBACK_COMPLETE',
              'UPDATE_ROLLBACK_COMPLETE', 'CREATE_FAILED', 'IMPORT_COMPLETE',
          }

          def handler(event, context):
              region = os.environ.get('AWS_REGION', 'us-east-1')
              cfn = boto3.client('cloudformation', region_name=region)

              paginator = cfn.get_paginator('list_stacks')
              to_delete = []
              for page in paginator.paginate(StackStatusFilter=list(TERMINAL)):
                  for s in page['StackSummaries']:
                      if s['StackName'] not in EXCLUDE:
                          to_delete.append(s['StackName'])

              if not to_delete:
                  print('No lab stacks found — account is clean.')
                  return

              print(f'Stacks to delete: {to_delete}')
              for name in to_delete:
                  try:
                      cfn.delete_stack(StackName=name)
                      print(f'Deleting: {name}')
                  except Exception as e:
                      print(f'Skip {name}: {e}')

  GuardianPermission:
    Type: AWS::Lambda::Permission
    Properties:
      FunctionName: !GetAtt GuardianFn.Arn
      Action: lambda:InvokeFunction
      Principal: events.amazonaws.com
      SourceArn: !GetAtt GuardianRule.Arn

  # COT hours → UTC: 5AM=10,6AM=11,7AM=12,12PM=17,7PM=0,8PM=1,9PM=2,10PM=3,11PM=4,12AM=5,1AM=6,2AM=7,3AM=8,4AM=9
  GuardianRule:
    Type: AWS::Events::Rule
    Properties:
      Name: account-guardian-schedule
      Description: "Destroy lab stacks at: 5,6,7AM | 12PM | 7,8,9,10,11PM | 12,1,2,3,4AM (COT)"
      ScheduleExpression: cron(0 0,1,2,3,4,5,6,7,8,9,10,11,12,17 * * ? *)
      State: ENABLED
      Targets:
        - Id: GuardianFn
          Arn: !GetAtt GuardianFn.Arn
YAML
)

echo "${TEMPLATE}" > /tmp/account-guardian-template.yaml

aws --profile "${PROFILE}" cloudformation deploy \
  --region "${REGION}" \
  --template-file /tmp/account-guardian-template.yaml \
  --stack-name AccountGuardianStack \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset

echo "    AccountGuardianStack deployed."

# ─── 2. AWS Budget ───────────────────────────────────────────────────────────
echo ""
echo "==> [2/3] Creating AWS Budget (monthly \$${BUDGET_LIMIT} — alerts at 80% and 100%)..."

aws --profile "${PROFILE}" budgets create-budget \
  --account-id "${ACCOUNT_ID}" \
  --budget "{
    \"BudgetName\": \"monthly-lab-budget\",
    \"BudgetLimit\": {
      \"Amount\": \"${BUDGET_LIMIT}\",
      \"Unit\": \"USD\"
    },
    \"TimeUnit\": \"MONTHLY\",
    \"BudgetType\": \"COST\"
  }" \
  --notifications-with-subscribers "[
    {
      \"Notification\": {
        \"NotificationType\": \"ACTUAL\",
        \"ComparisonOperator\": \"GREATER_THAN\",
        \"Threshold\": 80,
        \"ThresholdType\": \"PERCENTAGE\"
      },
      \"Subscribers\": [{
        \"SubscriptionType\": \"EMAIL\",
        \"Address\": \"${ALERT_EMAIL}\"
      }]
    },
    {
      \"Notification\": {
        \"NotificationType\": \"ACTUAL\",
        \"ComparisonOperator\": \"GREATER_THAN\",
        \"Threshold\": 100,
        \"ThresholdType\": \"PERCENTAGE\"
      },
      \"Subscribers\": [{
        \"SubscriptionType\": \"EMAIL\",
        \"Address\": \"${ALERT_EMAIL}\"
      }]
    }
  ]" 2>&1 && echo "    Budget created." || echo "    Budget already exists — skipping."

# ─── 3. Cost Anomaly Detection ───────────────────────────────────────────────
echo ""
echo "==> [3/3] Setting up Cost Anomaly Detection..."

MONITOR_ARN=$(aws --profile "${PROFILE}" ce create-anomaly-monitor \
  --anomaly-monitor "{
    \"MonitorName\": \"lab-anomaly-monitor\",
    \"MonitorType\": \"DIMENSIONAL\",
    \"MonitorDimension\": \"SERVICE\"
  }" \
  --query AnomalyMonitorArn --output text 2>/dev/null || \
  aws --profile "${PROFILE}" ce list-anomaly-monitors \
    --query 'AnomalyMonitors[?MonitorName==`lab-anomaly-monitor`].MonitorArn' \
    --output text)

aws --profile "${PROFILE}" ce create-anomaly-subscription \
  --anomaly-subscription "{
    \"SubscriptionName\": \"lab-anomaly-alert\",
    \"MonitorArnList\": [\"${MONITOR_ARN}\"],
    \"Subscribers\": [{
      \"Address\": \"${ALERT_EMAIL}\",
      \"Type\": \"EMAIL\"
    }],
    \"Threshold\": 5,
    \"Frequency\": \"DAILY\"
  }" && echo "    Anomaly detection configured." || echo "    Anomaly subscription already exists — skipping."

echo ""
echo "✅  Account guardian active:"
echo "    - Destroys all lab stacks at: 5,6,7AM | 12PM | 7,8,9,10,11PM | 12,1,2,3,4AM COT (14x/day)"
echo "    - Budget alert at \$$(echo "${BUDGET_LIMIT} * 0.8" | bc) and \$${BUDGET_LIMIT} → ${ALERT_EMAIL}"
echo "    - Cost anomaly detection: alert if daily spike > \$5"
