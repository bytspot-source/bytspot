locals {
  api_host  = regexreplace(google_cloud_run_v2_service.api.uri, "https://([^/]+)/.*", "$1")
  dash_host = regexreplace(google_cloud_run_v2_service.dashboard.uri, "https://([^/]+)/.*", "$1")
  lb_api_host = var.api_domain
}

# Uptime checks
resource "google_monitoring_uptime_check_config" "api_http" {
  display_name = "${local.name}-api-uptime"
  timeout      = "10s"
  period       = "60s"

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.api_host
    }
  }

  http_check {
    path         = "/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
}

resource "google_monitoring_uptime_check_config" "dashboard_http" {
  display_name = "${local.name}-dashboard-uptime"
  timeout      = "10s"
  period       = "60s"

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.dash_host
    }
  }

  http_check {
    path         = "/"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
}

# Optional uptime check against LB domain for API when LB is enabled
resource "google_monitoring_uptime_check_config" "api_http_lb" {
  count        = var.enable_lb_api && var.api_domain != "" ? 1 : 0
  display_name = "${local.name}-api-uptime-lb"
  timeout      = "10s"
  period       = "60s"

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.lb_api_host
    }
  }

  http_check {
    path         = "/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
}

# Alert: High 5xx on API
resource "google_monitoring_alert_policy" "api_5xx" {
  display_name = "${local.name}-api-5xx"
  combiner     = "OR"

  conditions {
    display_name = "High 5xx count"
    condition_threshold {
      # Cloud Run request_count classified by response code class
      filter          = "metric.type=\"run.googleapis.com/request_count\" resource.type=\"cloud_run_revision\" metric.label.response_code_class=\"5xx\" resource.label.service_name=\"${google_cloud_run_v2_service.api.name}\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }

  notification_channels = var.notification_channels
}

# Alert: API uptime check failing
resource "google_monitoring_alert_policy" "api_uptime" {
  display_name = "${local.name}-api-uptime-alert"
  combiner     = "OR"

  conditions {
    display_name = "Uptime check failing"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" resource.type=\"uptime_url\" resource.label.host=\"${local.api_host}\""
      duration        = "180s"
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_NEXT_OLDER"
      }
    }
  }

  notification_channels = var.notification_channels
}

# Alert: Dashboard uptime check failing
resource "google_monitoring_alert_policy" "dashboard_uptime" {
  display_name = "${local.name}-dashboard-uptime-alert"
  combiner     = "OR"

  conditions {
    display_name = "Uptime check failing"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" resource.type=\"uptime_url\" resource.label.host=\"${local.dash_host}\""
      duration        = "180s"
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_NEXT_OLDER"
      }
    }
  }

  notification_channels = var.notification_channels
}

