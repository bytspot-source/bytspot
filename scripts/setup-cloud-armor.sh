#!/bin/bash

# Bytspot Cloud Armor Security Policy Setup
# This script creates a comprehensive Cloud Armor security policy for the Bytspot API

set -e

POLICY_NAME="bytspot-security-policy"
PROJECT_ID=$(gcloud config get-value project)

echo "🔒 Setting up Cloud Armor security policy: $POLICY_NAME"
echo "📋 Project: $PROJECT_ID"

# Create the main security policy
echo "Creating security policy..."
gcloud compute security-policies create $POLICY_NAME \
    --description="Bytspot API security policy with rate limiting and geo-blocking" \
    --type=CLOUD_ARMOR

# Rule 1000: Rate limiting (100 requests per minute per IP)
echo "Adding rate limiting rule..."
gcloud compute security-policies rules create 1000 \
    --security-policy=$POLICY_NAME \
    --expression="true" \
    --action=rate-based-ban \
    --rate-limit-threshold-count=100 \
    --rate-limit-threshold-interval-sec=60 \
    --ban-duration-sec=600 \
    --conform-action=allow \
    --exceed-action=deny-429 \
    --enforce-on-key=IP

# Rule 2000: Block common attack patterns
echo "Adding SQL injection protection..."
gcloud compute security-policies rules create 2000 \
    --security-policy=$POLICY_NAME \
    --expression="evaluatePreconfiguredExpr('sqli-stable')" \
    --action=deny-403

# Rule 3000: Block XSS attempts
echo "Adding XSS protection..."
gcloud compute security-policies rules create 3000 \
    --security-policy=$POLICY_NAME \
    --expression="evaluatePreconfiguredExpr('xss-stable')" \
    --action=deny-403

# Rule 4000: Block scanner detection
echo "Adding scanner detection..."
gcloud compute security-policies rules create 4000 \
    --security-policy=$POLICY_NAME \
    --expression="evaluatePreconfiguredExpr('scannerdetection-stable')" \
    --action=deny-403

# Rule 5000: Protocol attack protection
echo "Adding protocol attack protection..."
gcloud compute security-policies rules create 5000 \
    --security-policy=$POLICY_NAME \
    --expression="evaluatePreconfiguredExpr('protocolattack-stable')" \
    --action=deny-403

# Rule 6000: Session fixation protection
echo "Adding session fixation protection..."
gcloud compute security-policies rules create 6000 \
    --security-policy=$POLICY_NAME \
    --expression="evaluatePreconfiguredExpr('sessionfixation-stable')" \
    --action=deny-403

# Rule 9000: Allow health checks (high priority)
echo "Adding health check allowlist..."
gcloud compute security-policies rules create 9000 \
    --security-policy=$POLICY_NAME \
    --expression="request.path.matches('/health')" \
    --action=allow

echo "✅ Cloud Armor security policy '$POLICY_NAME' created successfully!"
echo ""
echo "📊 Policy Summary:"
echo "  - Rate limiting: 100 req/min per IP"
echo "  - SQL injection protection: Enabled"
echo "  - XSS protection: Enabled"
echo "  - Scanner detection: Enabled"
echo "  - Protocol attack protection: Enabled"
echo "  - Session fixation protection: Enabled"
echo "  - Health check allowlist: Enabled"
echo ""
echo "🔧 To use this policy, update your Terraform configuration:"
echo "   cloud_armor_policy = \"$POLICY_NAME\""
echo ""
echo "📈 Monitor policy effectiveness:"
echo "   gcloud logging read 'resource.type=\"http_load_balancer\" AND jsonPayload.enforcedSecurityPolicy.name=\"$POLICY_NAME\"' --limit=10"
