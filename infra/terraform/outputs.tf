output "cloud_run_api_url" { value = google_cloud_run_v2_service.api.uri }
output "cloud_run_dashboard_url" { value = google_cloud_run_v2_service.dashboard.uri }
output "sql_connection_name" { value = google_sql_database_instance.pg.connection_name }
output "artifact_repo" { value = google_artifact_registry_repository.repo.repository_id }
output "pubsub_topic" { value = google_pubsub_topic.events.name }

# OIDC outputs for GitHub Actions configuration (guarded when create_wif=false)
output "workload_identity_provider" {
  value       = var.create_wif ? google_iam_workload_identity_pool_provider.github[0].name : null
  description = "Resource name of the Workload Identity Provider (null if create_wif=false)"
}

output "deployer_service_account" {
  value       = var.create_wif ? google_service_account.deployer.email : null
  description = "Email of the deployer service account (null if create_wif=false)"
}
