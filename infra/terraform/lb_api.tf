# Optional HTTPS External Load Balancer in front of the API (Cloud Run)
# Controlled by variables:
# - enable_lb_api (bool)
# - api_domain (string)
# - iap_enabled (bool)
# - iap_client_id (string), iap_client_secret (string)
# - cloud_armor_policy (string) - optional, name or self_link of existing policy

locals {
  api_lb_enabled = var.enable_lb_api
}

# Serverless NEG targeting Cloud Run API (regional)
resource "google_compute_region_network_endpoint_group" "api_neg" {
  count  = local.api_lb_enabled ? 1 : 0
  name   = "${local.name}-api-neg"
  region = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service  = google_cloud_run_v2_service.api.name
  }
}

# Backend service for the NEG (global)
resource "google_compute_backend_service" "api_backend" {
  count = local.api_lb_enabled ? 1 : 0
  name  = "${local.name}-api-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol = "HTTPS"
  log_config { enable = true }

  dynamic "iap" {
    for_each = var.iap_enabled ? [1] : []
    content {
      enabled              = true
      oauth2_client_id     = var.iap_client_id
      oauth2_client_secret = var.iap_client_secret
    }
  }

  backend {
    group = google_compute_region_network_endpoint_group.api_neg[0].self_link
  }

  dynamic "security_settings" {
    for_each = var.cloud_armor_policy != null && var.cloud_armor_policy != "" ? [1] : []
    content {
      # Attach existing Cloud Armor policy by name or self_link
      # For self_link, ensure it matches the expected format
      # When name is provided, the provider resolves within the project
      security_policy = var.cloud_armor_policy
    }
  }
}

# URL map (global)
resource "google_compute_url_map" "api_url_map" {
  count        = local.api_lb_enabled ? 1 : 0
  name         = "${local.name}-api-url-map"
  default_service = google_compute_backend_service.api_backend[0].self_link
}

# Managed certificate for the API domain (global)
resource "google_compute_managed_ssl_certificate" "api_cert" {
  count = local.api_lb_enabled && var.api_domain != "" ? 1 : 0
  name  = "${local.name}-api-cert"
  managed {
    domains = [var.api_domain]
  }
}

# Target HTTPS proxy (global)
resource "google_compute_target_https_proxy" "api_https_proxy" {
  count      = local.api_lb_enabled ? 1 : 0
  name       = "${local.name}-api-https-proxy"
  url_map    = google_compute_url_map.api_url_map[0].self_link
  ssl_certificates = length(google_compute_managed_ssl_certificate.api_cert) > 0 ? [google_compute_managed_ssl_certificate.api_cert[0].self_link] : []
}

# Global static IP (optional but recommended); reserve one for the LB
resource "google_compute_global_address" "api_ip" {
  count = local.api_lb_enabled ? 1 : 0
  name  = "${local.name}-api-ip"
}

# Global forwarding rule on 443 (global)
resource "google_compute_global_forwarding_rule" "api_fr" {
  count       = local.api_lb_enabled ? 1 : 0
  name        = "${local.name}-api-fr"
  target      = google_compute_target_https_proxy.api_https_proxy[0].self_link
  port_range  = "443"
  ip_protocol = "TCP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address  = google_compute_global_address.api_ip[0].self_link
}

output "api_lb_ip" {
  description = "Global static IP for API HTTPS Load Balancer"
  value       = local.api_lb_enabled ? google_compute_global_address.api_ip[0].address : null
}

output "api_lb_domain" {
  description = "Domain configured for the API LB (if provided)"
  value       = local.api_lb_enabled && var.api_domain != "" ? var.api_domain : null
}

