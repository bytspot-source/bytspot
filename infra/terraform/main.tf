terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google      = { source = "hashicorp/google",      version = ">= 5.40.0" }
    google-beta = { source = "hashicorp/google-beta", version = ">= 5.40.0" }
    random      = { source = "hashicorp/random",      version = ">= 3.6.0" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

locals { name = "bytspot-${var.environment}" }

locals {
  connector_name = var.serverless_connector_name != "" ? var.serverless_connector_name : "bytspot-${var.environment}-connector"
}


# Enable APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "compute.googleapis.com",
    "vpcaccess.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "pubsub.googleapis.com",
    "firestore.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com"
  ])
  service = each.key
}

# Networking & VPC connector
resource "google_compute_network" "vpc" {
  name                     = "${local.name}-vpc"
  auto_create_subnetworks  = false
}
resource "google_compute_subnetwork" "subnet" {
  name          = "${local.name}-subnet"
  ip_cidr_range = "10.10.0.0/16"
  region        = var.region
  network       = google_compute_network.vpc.id
}
resource "google_vpc_access_connector" "serverless" {
  count          = var.enable_serverless_connector ? 1 : 0
  name           = local.connector_name
  region         = var.region
  network        = google_compute_network.vpc.name
  ip_cidr_range  = var.serverless_connector_ip_cidr
  machine_type   = var.serverless_connector_machine_type
  min_instances  = var.serverless_connector_min_instances
  max_instances  = var.serverless_connector_max_instances
}

# Artifact Registry
resource "google_artifact_registry_repository" "repo" {
  location = var.region
  repository_id = "${local.name}-images"
  format = "DOCKER"
}

# Service Accounts & IAM
resource "google_service_account" "api_sa" { account_id = "${local.name}-api" }
resource "google_project_iam_member" "api_sa_sql" {
  role   = "roles/cloudsql.client"
  member = "serviceAccount:${google_service_account.api_sa.email}"
}
resource "google_project_iam_member" "api_sa_sm" {
  role   = "roles/secretmanager.secretAccessor"
  member = "serviceAccount:${google_service_account.api_sa.email}"
}
resource "google_project_iam_member" "api_sa_fs" {
  role   = "roles/datastore.user"
  member = "serviceAccount:${google_service_account.api_sa.email}"
}
resource "google_project_iam_member" "api_sa_pub" {
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.api_sa.email}"
}

# Cloud SQL Postgres
resource "random_password" "db" {
  length  = 24
  special = true
}
resource "google_sql_database_instance" "pg" {
  name             = "${local.name}-pg"
  region           = var.region
  database_version = var.db_version
  settings {
    tier = var.db_tier
    availability_type = var.db_ha ? "REGIONAL" : "ZONAL"
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
    }
    backup_configuration { enabled = true }
    maintenance_window {
      day  = 7
      hour = 2
    }
  }
}
resource "google_sql_user" "dbuser" {
  instance = google_sql_database_instance.pg.name
  name     = "app"
  password = random_password.db.result
}
resource "google_sql_database" "appdb" {
  instance = google_sql_database_instance.pg.name
  name     = "bytspot"
}

# Secret Manager
resource "google_secret_manager_secret" "jwt" {
  secret_id = "${local.name}-jwt"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "jwt_v" {
  secret      = google_secret_manager_secret.jwt.id
  secret_data = "CHANGE_ME_DEV"
}

resource "google_secret_manager_secret" "stripe" {
  secret_id = "${local.name}-stripe"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "stripe_v" {
  secret      = google_secret_manager_secret.stripe.id
  secret_data = "sk_test_xxx"
}

# Firestore (optional)
resource "google_firestore_database" "default" {
  count       = var.enable_firestore ? 1 : 0
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"
}

# Memorystore (optional)
resource "google_redis_instance" "cache" {
  count = var.enable_memorystore ? 1 : 0
  name  = "${local.name}-cache"
  tier  = "STANDARD_HA"
  memory_size_gb = 1
  region = var.region
  authorized_network = google_compute_network.vpc.id
}

# Pub/Sub
resource "google_pubsub_topic" "events" { name = "${local.name}-events" }

# Cloud Run services
resource "google_cloud_run_v2_service" "api" {
  name     = "${local.name}-api"
  location = var.region
  template {
    service_account = google_service_account.api_sa.email
    dynamic "vpc_access" {
      for_each = var.enable_serverless_connector ? [1] : []
      content {
        connector = google_vpc_access_connector.serverless[0].id
        egress    = "ALL_TRAFFIC"
      }
    }
    scaling {
      min_instance_count = 1
      max_instance_count = var.max_instances_api
    }

    # Mount Cloud SQL Unix socket at /cloudsql for DATABASE_URL host path
    volumes {
      name = "cloudsql"
      cloud_sql_instance { instances = [google_sql_database_instance.pg.connection_name] }
    }
    containers {
      image = var.api_image
      resources { cpu_idle = true }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      env {
        name  = "DATABASE_URL"
        value = "postgres://app:${random_password.db.result}@/${google_sql_database.appdb.name}?host=/cloudsql/${google_sql_database_instance.pg.connection_name}"
      }
      readiness_probe {
        http_get { path = "/health" }
        period_seconds    = 10
        failure_threshold = 3
      }
      liveness_probe {
        http_get { path = "/health" }
        period_seconds    = 10
        failure_threshold = 3
      }
    }
  }
  ingress = var.enable_lb_api ? "INGRESS_TRAFFIC_INTERNAL_AND_LB" : "INGRESS_TRAFFIC_ALL"

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[0].env,
    ]
  }
}

resource "google_cloud_run_v2_service" "dashboard" {
  name     = "${local.name}-dashboard"
  location = var.region
  template {
    scaling { min_instance_count = 0 }
    containers {
      image = var.dashboard_image
      readiness_probe {
        http_get { path = "/" }
        period_seconds    = 10
        failure_threshold = 3
      }
      liveness_probe {
        http_get { path = "/" }
        period_seconds    = 10
        failure_threshold = 3
      }
    }
  }
  ingress = "INGRESS_TRAFFIC_ALL"
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[0].env,
    ]
  }
}


# Make dashboard publicly invokable; keep API authenticated
resource "google_cloud_run_v2_service_iam_member" "dashboard_public" {
  name     = google_cloud_run_v2_service.dashboard.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

