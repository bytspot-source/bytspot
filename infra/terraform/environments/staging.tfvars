project_id  = "my-projectbytspot-25971"
region      = "us-west1"
environment = "stg"

# Use default hello image at bootstrap; CI/CD will replace on first deploy
# api_image       = "us-west1-docker.pkg.dev/byspot-project-420/bytspot-stg-images/bytspot-api:stg"
# dashboard_image = "us-west1-docker.pkg.dev/byspot-project-420/bytspot-stg-images/bytspot-dashboard:stg"

db_ha = false

# Real Bytspot Microservices Configuration
jwt_secret = "stg_jwt_secret_change_me"

# Enable Redis for microservices
enable_memorystore = true

# Microservices image configuration (will be updated by CI/CD)
auth_service_image = "us-west1-docker.pkg.dev/my-projectbytspot-25971/bytspot-stg-images/bytspot-auth-service:stg"
venue_service_image = "us-west1-docker.pkg.dev/my-projectbytspot-25971/bytspot-stg-images/bytspot-venue-service:stg"
gateway_bff_image = "us-west1-docker.pkg.dev/my-projectbytspot-25971/bytspot-stg-images/bytspot-gateway-bff:stg"

# Enable GitHub OIDC/WIF for CI/CD
create_wif = false
wif_pool_project_number = "908800993713"

github_org  = "bytspot-source" # change to your GitHub org/user
github_repo = "bytspot"        # change to your GitHub repo name

# Disable VPC connector for now; Cloud Run will use Cloud SQL connector (no VPC needed)
enable_serverless_connector = false


# Serverless VPC Access connector settings (match the manually created connector)
serverless_connector_ip_cidr       = "10.9.0.16/28"
serverless_connector_machine_type  = "e2-micro"
serverless_connector_min_instances = 2
serverless_connector_max_instances = 10


# Optional override to avoid name reservation issues
serverless_connector_name = "bytspot-stg-connector-1"

# Domain configuration options for staging (uncomment and configure as needed)
# Option 1: Direct Cloud Run domain mapping for dashboard
# enable_domain_mapping_dashboard = true
# dashboard_domain = "app-stg.bytspot.com"

# Option 2: Load balancer with custom domain for API
# enable_lb_api = true
# api_domain = "api-stg.bytspot.com"

# Example staging setup:
# enable_domain_mapping_dashboard = true
# dashboard_domain = "app-stg.bytspot.com"
