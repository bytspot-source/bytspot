# GitHub OIDC (Workload Identity Federation) to allow GitHub Actions to impersonate a deployer SA
# Controlled by create_wif variable

data "google_project" "current" {}

resource "google_iam_workload_identity_pool" "github" {
  count    = var.create_wif ? 1 : 0
  project  = var.project_id
  location = "global"

  workload_identity_pool_id = var.wif_pool_id
  display_name              = "GitHub OIDC Pool"
  description               = "OIDC pool for GitHub Actions"

  depends_on = [
    google_project_service.apis["iam.googleapis.com"],
    google_project_service.apis["iamcredentials.googleapis.com"],
    google_project_service.apis["sts.googleapis.com"],
  ]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count    = var.create_wif ? 1 : 0
  project  = var.project_id
  location = "global"

  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "GitHub Actions"
  description                        = "Trust GitHub OIDC tokens"

  attribute_mapping = {
    "google.subject"      = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  depends_on = [
    google_iam_workload_identity_pool.github,
    google_project_service.apis["iam.googleapis.com"],
    google_project_service.apis["iamcredentials.googleapis.com"],
    google_project_service.apis["sts.googleapis.com"],
  ]
}

# Deployer service account with least-privilege roles for CI/CD
resource "google_service_account" "deployer" {
  account_id   = "${local.name}-deployer"
  display_name = "Bytspot ${var.environment} Deployer"
}

resource "google_service_account_iam_binding" "wif_user" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  members = [
    "principalSet://iam.googleapis.com/projects/${coalesce(var.wif_pool_project_number, data.google_project.current.number)}/locations/global/workloadIdentityPools/${var.wif_pool_id}/attribute.repository/${var.github_org}/${var.github_repo}"
  ]
}

# Project roles for deployer SA (refine to least-privilege per needs)
resource "google_project_iam_member" "deployer_run" {
  role   = "roles/run.admin"
  member = "serviceAccount:${google_service_account.deployer.email}"
}
resource "google_project_iam_member" "deployer_ar" {
  role   = "roles/artifactregistry.writer"
  member = "serviceAccount:${google_service_account.deployer.email}"
}
resource "google_project_iam_member" "deployer_view" {
  role   = "roles/viewer"
  member = "serviceAccount:${google_service_account.deployer.email}"
}

