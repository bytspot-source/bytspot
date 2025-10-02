# Bytspot Domain and Load Balancer Setup Guide

## Current Status ✅

**Services are currently accessible via default Cloud Run URLs:**

### Staging Environment
- **API**: `https://bytspot-stg-api-hlrj3enyxa-uw.a.run.app`
- **Dashboard**: `https://bytspot-stg-dashboard-hlrj3enyxa-uw.a.run.app`
- **Auth Service**: `https://bytspot-stg-auth-service-hlrj3enyxa-uw.a.run.app`

### Production Environment
- **API**: `https://bytspot-prod-api-hlrj3enyxa-uw.a.run.app`
- **Dashboard**: `https://bytspot-prod-dashboard-hlrj3enyxa-uw.a.run.app`
- **Auth Service**: `https://bytspot-prod-auth-service-hlrj3enyxa-uw.a.run.app`

## Domain Configuration Options

### Option 1: Direct Cloud Run Domain Mapping (Simple)

**Best for:** Simple setups, cost-effective, minimal configuration

**Configuration:**
```hcl
# In production.tfvars
enable_domain_mapping_dashboard = true
dashboard_domain = "app.bytspot.com"
```

**Benefits:**
- ✅ Simple setup
- ✅ Automatic SSL certificates
- ✅ No additional costs
- ✅ Direct Cloud Run integration

**Limitations:**
- ❌ No advanced security features
- ❌ No DDoS protection
- ❌ Limited traffic management

### Option 2: HTTPS Load Balancer + Cloud Armor (Advanced)

**Best for:** Production workloads, high traffic, advanced security needs

**Configuration:**
```hcl
# In production.tfvars
enable_lb_api = true
api_domain = "api.bytspot.com"
cloud_armor_policy = "bytspot-security-policy"

enable_domain_mapping_dashboard = true
dashboard_domain = "app.bytspot.com"
```

**Benefits:**
- ✅ DDoS protection via Cloud Armor
- ✅ Rate limiting and IP filtering
- ✅ Global load balancing
- ✅ Advanced security rules
- ✅ Better performance (CDN-like)

**Additional Costs:**
- Load balancer: ~$18/month
- Cloud Armor: ~$5/month + rules

### Option 3: Full Production Setup with IAP

**Best for:** Enterprise security, internal applications

**Configuration:**
```hcl
# In production.tfvars
enable_lb_api = true
api_domain = "api.bytspot.com"
iap_enabled = true
iap_client_id = "your-oauth2-client-id"
iap_client_secret = "your-oauth2-client-secret"
cloud_armor_policy = "bytspot-security-policy"

enable_domain_mapping_dashboard = true
dashboard_domain = "app.bytspot.com"
```

## Implementation Steps

### Prerequisites
1. **Own a domain** (e.g., `bytspot.com`)
2. **DNS access** to create A/CNAME records
3. **Terraform installed** locally
4. **Billing enabled** on GCP project

### Step 1: Choose Your Domains
```bash
# Recommended domain structure:
# Production:
api.bytspot.com      -> API with Load Balancer
app.bytspot.com      -> Dashboard (direct mapping)

# Staging:
api-stg.bytspot.com  -> API with Load Balancer  
app-stg.bytspot.com  -> Dashboard (direct mapping)
```

### Step 2: Create Cloud Armor Policy (Optional)
```bash
# Create security policy
gcloud compute security-policies create bytspot-security-policy \
    --description="Bytspot security policy"

# Add rate limiting rule
gcloud compute security-policies rules create 1000 \
    --security-policy=bytspot-security-policy \
    --expression="true" \
    --action=rate-based-ban \
    --rate-limit-threshold-count=100 \
    --rate-limit-threshold-interval-sec=60 \
    --ban-duration-sec=600

# Add geo-blocking rule (example)
gcloud compute security-policies rules create 2000 \
    --security-policy=bytspot-security-policy \
    --expression="origin.region_code == 'CN'" \
    --action=deny-403
```

### Step 3: Update Terraform Configuration

**For Production:**
```hcl
# environments/production.tfvars
enable_lb_api = true
api_domain = "api.bytspot.com"
cloud_armor_policy = "bytspot-security-policy"

enable_domain_mapping_dashboard = true
dashboard_domain = "app.bytspot.com"
```

**For Staging:**
```hcl
# environments/staging.tfvars
enable_lb_api = true
api_domain = "api-stg.bytspot.com"

enable_domain_mapping_dashboard = true
dashboard_domain = "app-stg.bytspot.com"
```

### Step 4: Apply Terraform
```bash
cd infra/terraform

# Apply staging
terraform plan -var-file=environments/staging.tfvars
terraform apply -var-file=environments/staging.tfvars

# Apply production
terraform plan -var-file=environments/production.tfvars
terraform apply -var-file=environments/production.tfvars
```

### Step 5: Configure DNS Records

After Terraform creates the resources, you'll get IP addresses to configure:

```bash
# Get the load balancer IP
terraform output api_lb_ip

# Create DNS records:
# A record: api.bytspot.com -> [LOAD_BALANCER_IP]
# A record: api-stg.bytspot.com -> [STAGING_LOAD_BALANCER_IP]

# For dashboard domain mappings, Cloud Run will provide CNAME targets
# CNAME: app.bytspot.com -> ghs.googlehosted.com
# CNAME: app-stg.bytspot.com -> ghs.googlehosted.com
```

## Monitoring and Verification

### Health Checks
```bash
# Test API through load balancer
curl https://api.bytspot.com/health

# Test dashboard direct mapping
curl https://app.bytspot.com/

# Check SSL certificate
openssl s_client -connect api.bytspot.com:443 -servername api.bytspot.com
```

### Cloud Armor Monitoring
```bash
# View security policy logs
gcloud logging read 'resource.type="http_load_balancer" AND jsonPayload.enforcedSecurityPolicy.name="bytspot-security-policy"' --limit=10
```

## Cost Estimation

### Option 1 (Direct Mapping Only)
- **Cost**: $0 additional (included in Cloud Run)
- **SSL**: Free managed certificates

### Option 2 (Load Balancer + Cloud Armor)
- **Load Balancer**: ~$18/month
- **Cloud Armor**: ~$5/month + $1 per million requests
- **SSL**: Free managed certificates
- **Total**: ~$25-30/month

### Option 3 (Full Enterprise)
- **Same as Option 2** + IAP costs
- **IAP**: Free for first 1000 users
- **Total**: ~$25-30/month

## Recommendations

### For Development/Staging
- Use **Option 1** (Direct mapping)
- Simple, cost-effective, sufficient for testing

### For Production (Small Scale)
- Use **Option 1** initially
- Upgrade to **Option 2** when traffic increases

### For Production (Enterprise)
- Use **Option 2** or **Option 3**
- Essential for security and performance
