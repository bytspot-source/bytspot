variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-east1"
}

variable "environment" {
  type = string
}

# Default to a public hello image so infra applies before first app build
variable "api_image" {
  type        = string
  description = "Container image for bytspot-api (legacy - will be removed)"
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "dashboard_image" {
  type        = string
  description = "Container image for bytspot-dashboard (React frontend)"
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

# Real Bytspot Microservices Images
variable "auth_service_image" {
  type        = string
  description = "Container image for auth-service (Go)"
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "venue_service_image" {
  type        = string
  description = "Container image for venue-service (Go)"
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "gateway_bff_image" {
  type        = string
  description = "Container image for gateway-bff (Node.js)"
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

# JWT Secret for authentication
variable "jwt_secret" {
  type        = string
  description = "JWT secret for authentication services"
  default     = "dev_secret_change_me_in_production"
  sensitive   = true
}

variable "db_tier" {
  type    = string
  default = "db-custom-2-7680"
}

variable "db_version" {
  type    = string
  default = "POSTGRES_15"
}

variable "db_ha" {
  type    = bool
  default = false
}

variable "enable_firestore" {
  type    = bool
  default = true
}

variable "firestore_location" {
  type    = string
  default = "nam5"
}

variable "enable_memorystore" {
  type    = bool
  default = true
}

variable "max_instances_api" {
  type    = number
  default = 50
}

variable "concurrency_api" {
  type    = number
  default = 80
}

# GitHub OIDC / Workload Identity Federation
variable "create_wif" {
  type    = bool
  default = true
}

variable "github_org" {
  type        = string
  description = "GitHub organization/owner"
  default     = ""
}

variable "github_repo" {
  type        = string
  description = "GitHub repository name"
  default     = ""
}

variable "wif_pool_id" {
  type    = string
  default = "github"
}


variable "notification_channels" {
  type        = list(string)
  default     = []
  description = "List of Monitoring notification channel IDs to attach to alert policies"
}


variable "wif_pool_project_number" {
  type        = string
  default     = null
  description = "Project number that hosts the shared WIF pool/provider. If null, use current project number."
}

# --- Optional HTTPS LB for API ---
variable "enable_lb_api" {
  type        = bool
  default     = false
  description = "Enable HTTPS External LB in front of the API (Cloud Run)."
}

variable "api_domain" {
  type        = string
  default     = ""
  description = "Domain name to use with the API HTTPS LB managed certificate (e.g., api.example.com)."
}

variable "iap_enabled" {
  type        = bool
  default     = false
  description = "Enable IAP on the API HTTPS LB backend. Requires OAuth2 client id/secret."
}

variable "iap_client_id" {
  type        = string
  default     = ""
  description = "OAuth2 client ID for IAP."
}

variable "iap_client_secret" {
  type        = string
  default     = ""
  description = "OAuth2 client secret for IAP."
}

variable "cloud_armor_policy" {
  type        = string
  default     = null
  description = "Existing Cloud Armor security policy self_link or name to attach to API backend (optional)."
}

# --- Optional domain mapping for Dashboard ---
variable "enable_domain_mapping_dashboard" {
  type        = bool
  default     = false
  description = "Create a direct Cloud Run domain mapping for the dashboard service."
}

variable "dashboard_domain" {
  type        = string
  default     = ""
  description = "Domain name to map to the dashboard service (e.g., dashboard.example.com)."
}


# --- Serverless VPC Access connector options ---
variable "enable_serverless_connector" {
  type        = bool
  description = "Enable creation and use of a Serverless VPC Access connector for Cloud Run egress. Not required for Cloud SQL connector."
  default     = false
}

variable "serverless_connector_ip_cidr" {
  type        = string
  description = "IP CIDR range (/28) for the Serverless VPC Access connector"
  default     = "10.8.0.0/28"
}

variable "serverless_connector_machine_type" {
  type        = string
  description = "Machine type for the Serverless VPC Access connector (e.g., e2-micro)"
  default     = "e2-micro"
}

variable "serverless_connector_min_instances" {
  type        = number
  description = "Minimum number of instances for the connector"
  default     = 2
}

variable "serverless_connector_max_instances" {
  type        = number
  description = "Maximum number of instances for the connector"
  default     = 10
}


# Optional override for Serverless VPC Access connector name
variable "serverless_connector_name" {
  type        = string
  default     = ""
  description = "If set, use this exact name for the connector instead of the default pattern (bytspot-<env>-connector)."
}
