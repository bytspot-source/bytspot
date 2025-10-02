# Optional direct domain mapping for the Dashboard Cloud Run service
# Controlled by variables:
# - enable_domain_mapping_dashboard (bool)
# - dashboard_domain (string)

locals { dash_domain_enabled = var.enable_domain_mapping_dashboard && var.dashboard_domain != "" }

resource "google_cloud_run_domain_mapping" "dashboard" {
  count    = local.dash_domain_enabled ? 1 : 0
  location = var.region
  name     = var.dashboard_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.dashboard.name
  }
}

output "dashboard_domain_mapping" {
  value       = local.dash_domain_enabled ? google_cloud_run_domain_mapping.dashboard[0].status : null
  description = "Status of the dashboard domain mapping"
}

