locals {
  # Computed defaults the control plane needs to find/drive its own runner
  # Job and talk to Postgres. var.env is merged in last so a caller can
  # override any of these if they ever need to.
  control_plane_env = merge(
    {
      GCP_PROJECT         = var.project_id
      GCP_REGION          = var.region
      CLOUDRUN_JOB_PREFIX = var.name
      RUNNER_IMAGE        = var.runner_image
      SANDBOX_RUNTIME     = "cloudrun"
      DBOS__VMID          = "cloudrun" # own executor id: never recover the VM control plane's workflows
      TICK_ENABLED        = "false"    # the VM control plane owns schedules + monitors
    },
    # Left unset when "": config.ts's PUBLIC_BASE_URL has its own default
    # ("http://localhost:3000") and requires a valid URL, so an empty
    # string here would fail validation on first boot instead of falling
    # through to that default. See variable "public_base_url".
    var.public_base_url != "" ? { PUBLIC_BASE_URL = var.public_base_url } : {},
    var.env,
  )

  # env name -> simple secret key. Only secrets that actually have a version are
  # referenced: Cloud Run rejects a secret_key_ref to a secret with no versions.
  control_plane_simple_secret_env = {
    CLAUDE_CODE_OAUTH_TOKEN = "claude-code-oauth-token"
    CLICKUP_API_TOKEN       = "clickup-api-token"
    CLICKUP_WEBHOOK_SECRET  = "clickup-webhook-secret"
    CLICKUP_CHAT_SECRET     = "clickup-chat-secret"
    GH_TOKEN                = "gh-token"
    SLACK_SIGNING_SECRET    = "slack-signing-secret"
    SLACK_BOT_TOKEN         = "slack-bot-token"
  }
  control_plane_secret_env = merge(
    {
      DATABASE_URL             = google_secret_manager_secret.database_url.secret_id
      DBOS_SYSTEM_DATABASE_URL = google_secret_manager_secret.dbos_system_database_url.secret_id
    },
    { for env_name, key in local.control_plane_simple_secret_env : env_name => google_secret_manager_secret.simple[key].secret_id if contains(local.simple_secret_keys_with_values, key) },
  )
}

# --- Control plane: always-on Cloud Run service -----------------------
resource "google_cloud_run_v2_service" "control_plane" {
  project             = var.project_id
  name                = "${var.name}-control-plane"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.control_plane.email

    # max_instance_count pinned to 1: DBOS runs as a single-node executor
    # here, so a second concurrent instance would double-process durable
    # workflow steps. Going beyond 1 needs DBOS's multi-executor
    # coordination story first, not just raising this number.
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = 1
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }

    containers {
      image = var.control_plane_image

      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        # Always-allocated CPU: the control plane polls DBOS workflow state
        # in the background between requests, so CPU can't be throttled to
        # zero the instant a request finishes (Cloud Run's default request-
        # scoped billing would starve that background work).
        cpu_idle = false
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      dynamic "env" {
        for_each = local.control_plane_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.control_plane_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 3000
        }
        initial_delay_seconds = 0
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 3
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_project_iam_member.control_plane,
    google_service_account_iam_member.control_plane_acts_as_runner,
  ]
}

# Webhooks (Slack, ClickUp) are signed at the app layer (SLACK_SIGNING_SECRET,
# CLICKUP_WEBHOOK_SECRET/CLICKUP_CHAT_SECRET), so Cloud Run's own invoker
# check would only add a redundant, and for public webhook senders
# impossible, IAM identity requirement.
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.control_plane.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Runner: one-shot Cloud Run Job, executed on demand by the control plane
# One Job per runner image; the control plane picks the Job from the role's image basename.
# A role's cpu/memoryMb do NOT apply here: RunJobRequest.Overrides carries only env, taskCount and timeout,
# so these limits are what every Cloud Run run actually gets. 4Gi killed an implement run part-way through
# a monorepo test suite (2026-09-18, "Container terminated on signal 7").
locals {
  runner_jobs = merge({
    # runner: 16Gi was set by hand (gcloud) on a live job before it was codified here.
    runner     = { image = var.runner_image, cpu = "4", memory = "16Gi", timeout = "5400s" }
    runner-ops = { image = var.runner_ops_image, cpu = "4", memory = "8Gi", timeout = "5400s" }
  }, var.extra_runner_images)
}

resource "google_cloud_run_v2_job" "runner" {
  for_each            = local.runner_jobs
  project             = var.project_id
  name                = "${var.name}-${each.key}"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.runner.email
      # Per-run timeout comes from the role via execution overrides; this is only the ceiling for one (per job, see runner_jobs).
      timeout     = each.value.timeout
      max_retries = 0

      containers {
        image = each.value.image
        resources {
          limits = {
            cpu    = each.value.cpu
            memory = each.value.memory
          }
        }
        # Env is empty by design: the control plane supplies per-run env via execution overrides.
      }
    }
  }

  depends_on = [google_project_service.apis]
}
