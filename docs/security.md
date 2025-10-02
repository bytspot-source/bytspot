# Bytspot Security Architecture

## Current Security Model ✅

### API Security (Private)
- **Authentication Required**: API service has NO `allUsers` IAM binding
- **Access Control**: Only authenticated requests can invoke the API
- **Service Account**: Uses dedicated service account `bytspot-prod-api@my-projectbytspot-25971.iam.gserviceaccount.com`
- **Database Access**: Secure Cloud SQL connection via Unix socket
- **VPC Access**: Connected to VPC via Serverless VPC Connector for internal communication

### Dashboard Security (Public)
- **Public Access**: Dashboard has `allUsers` invoker permission (intentionally public)
- **Frontend Only**: Serves static frontend assets, no sensitive backend logic
- **API Communication**: Communicates with API using proper authentication

## Security Hardening Options 🔒

### Level 1: Current Configuration (Recommended for most use cases)
```hcl
# In production.tfvars
enable_lb_api = false
```
- API requires authentication (no allUsers access)
- Dashboard is publicly accessible
- Direct Cloud Run ingress (HTTPS by default)
- Suitable for most production workloads

### Level 2: HTTPS Load Balancer + Cloud Armor
```hcl
# In production.tfvars
enable_lb_api = true
api_domain = "api.bytspot.com"
cloud_armor_policy = "bytspot-security-policy"
```

**Benefits:**
- DDoS protection via Cloud Armor
- Rate limiting and IP filtering
- Custom security rules
- Global load balancing
- Managed SSL certificates

**When to use:** High-traffic applications, need for advanced DDoS protection

### Level 3: Identity-Aware Proxy (IAP) Authentication
```hcl
# In production.tfvars
enable_lb_api = true
api_domain = "api.bytspot.com"
iap_enabled = true
iap_client_id = "your-oauth2-client-id"
iap_client_secret = "your-oauth2-client-secret"
```

**Benefits:**
- Google-managed authentication
- No need for custom auth in application
- Integration with Google Workspace/Cloud Identity
- Centralized access control

**When to use:** Internal applications, need for centralized identity management

## Implementation Guide

### Current Status Verification
```bash
# Check API access (should require authentication)
curl https://bytspot-prod-api-908800993713.us-west1.run.app/health
# Expected: 403 Forbidden (good - requires auth)

# Check Dashboard access (should be public)
curl https://bytspot-prod-dashboard-908800993713.us-west1.run.app/
# Expected: 200 OK (good - public access)
```

### Enabling Advanced Security

#### Step 1: Create Cloud Armor Policy (Optional)
```bash
gcloud compute security-policies create bytspot-security-policy \
    --description="Bytspot API security policy"

# Add rate limiting rule
gcloud compute security-policies rules create 1000 \
    --security-policy=bytspot-security-policy \
    --expression="true" \
    --action=rate-based-ban \
    --rate-limit-threshold-count=100 \
    --rate-limit-threshold-interval-sec=60 \
    --ban-duration-sec=600
```

#### Step 2: Configure OAuth2 for IAP (Optional)
1. Go to Google Cloud Console > APIs & Services > Credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Add authorized redirect URIs: `https://iap.googleapis.com/v1/oauth/clientIds/CLIENT_ID:handleRedirect`
4. Note the Client ID and Secret

#### Step 3: Update Terraform Configuration
```bash
# Update production.tfvars with desired security level
# Apply changes
cd infra/terraform
terraform plan -var-file=environments/production.tfvars
terraform apply -var-file=environments/production.tfvars
```

## Security Monitoring

### Key Metrics to Monitor
- API authentication failures
- Unusual traffic patterns
- Cloud Armor rule triggers
- IAP authentication events

### Alerts Configuration
- High error rates (4xx/5xx)
- Unusual geographic access patterns
- Rate limit violations
- Failed authentication attempts

## Best Practices

1. **Principle of Least Privilege**: API requires authentication, dashboard is public only for UI
2. **Defense in Depth**: Multiple security layers (IAM, ingress controls, optional LB/Armor)
3. **Monitoring**: Comprehensive logging and alerting
4. **Regular Reviews**: Periodic security configuration audits
5. **Secrets Management**: Use Secret Manager for sensitive configuration

## Compliance Considerations

- **Data Privacy**: API authentication protects sensitive data access
- **Audit Logging**: All API access is logged via Cloud Run
- **Encryption**: HTTPS enforced for all traffic
- **Access Controls**: IAM-based service access control
