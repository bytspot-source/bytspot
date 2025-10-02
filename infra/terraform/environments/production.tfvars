project_id = "my-projectbytspot-25971"
region     = "us-west1"
environment = "prod"
create_wif = false
wif_pool_id = "github-prod"
wif_pool_project_number = "908800993713"

# Real Bytspot Microservices Configuration
jwt_secret = "prod_jwt_secret_change_me_in_production"

# Enable Redis for microservices
enable_memorystore = true
enable_serverless_connector = true

# Microservices image configuration (will be updated by CI/CD)
auth_service_image = "us-west1-docker.pkg.dev/my-projectbytspot-25971/bytspot-prod-images/bytspot-auth-service:prod"
venue_service_image = "us-west1-docker.pkg.dev/my-projectbytspot-25971/bytspot-prod-images/bytspot-venue-service:prod"
gateway_bff_image = "us-west1-docker.pkg.dev/my-projectbytspot-25971/bytspot-prod-images/bytspot-gateway-bff:prod"

# Use default hello image at bootstrap; CI/CD will replace on deploy
# api_image = "us-east1-docker.pkg.dev/articulate-bot-468815-n3/bytspot-prod-images/bytspot-api:latest"
# dashboard_image = "us-east1-docker.pkg.dev/articulate-bot-468815-n3/bytspot-prod-images/bytspot-dashboard:latest"
db_ha = true
max_instances_api = 200

github_org = "bytspot-source" # change to your GitHub org/user
github_repo = "bytspot"        # change to your GitHub repo name

# Security and networking hardening options
# API Load Balancer with advanced security (optional)
enable_lb_api = false  # Set to true to enable HTTPS LB + advanced security
api_domain = ""        # Set to your API domain (e.g., "api.bytspot.com") if using LB

# Identity-Aware Proxy (IAP) for API authentication (requires enable_lb_api = true)
iap_enabled = false    # Set to true to enable IAP authentication
iap_client_id = ""     # OAuth2 client ID for IAP (required if iap_enabled = true)
iap_client_secret = "" # OAuth2 client secret for IAP (required if iap_enabled = true)

# Cloud Armor security policy (optional, requires enable_lb_api = true)
cloud_armor_policy = null  # Set to existing Cloud Armor policy name or self_link

# Domain configuration options (uncomment and configure as needed)
# Option 1: Direct Cloud Run domain mapping for dashboard (simple, cost-effective)
# enable_domain_mapping_dashboard = true
# dashboard_domain = "app.bytspot.com"

# Option 2: Custom domains with examples
# api_domain = "api.bytspot.com"        # For use with enable_lb_api = true
# dashboard_domain = "app.bytspot.com"  # For direct Cloud Run mapping

# Example full production setup with advanced security:
# enable_lb_api = true
# api_domain = "api.bytspot.com"
# enable_domain_mapping_dashboard = true
# dashboard_domain = "app.bytspot.com"
# cloud_armor_policy = "bytspot-security-policy"
