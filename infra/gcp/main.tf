locals {
  apis = [
    "container.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "aiplatform.googleapis.com",
    "iam.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(local.apis)

  project                    = var.project_id
  service                    = each.value
  disable_dependent_services = false
  disable_on_destroy         = false
}

# --- GKE Autopilot cluster ------------------------------------------------
# Autopilot forces Workload Identity on for every cluster, so there is no
# `workload_identity_config` block to set here (it's implicit, per Google's
# docs and the task spec). The per-SA bindings live in iam.tf.
resource "google_container_cluster" "primary" {
  name     = var.name
  project  = var.project_id
  location = var.region

  enable_autopilot = true

  release_channel {
    channel = "REGULAR"
  }

  deletion_protection = false

  depends_on = [google_project_service.apis]
}

# --- Artifact Registry -----------------------------------------------------
resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = var.name
  format        = "DOCKER"
  description   = "Control-plane and runner images for ${var.name}"

  depends_on = [google_project_service.apis]
}

# --- Cloud SQL ---------------------------------------------------------
# Networking decision: private IP (no public exposure) would need a VPC,
# a reserved peering range, and a `google_service_networking_connection` —
# real infra plus a slow first-apply. That's more than this small service
# needs, so we use public IP with no authorized networks and no listener
# other than the Cloud SQL Auth Proxy: the control-plane pod must connect
# via the Cloud SQL Auth Proxy sidecar (or the Cloud SQL Node.js connector)
# rather than dialing the public IP directly. See README.md.
resource "google_sql_database_instance" "main" {
  project          = var.project_id
  name             = "${var.name}-pg"
  region           = var.region
  database_version = "POSTGRES_17"

  settings {
    tier = var.db_tier

    ip_configuration {
      ipv4_enabled = true
      # No authorized_networks block: nothing is allowlisted to hit the
      # public IP directly; access is via the Cloud SQL Auth Proxy, which
      # authenticates with IAM instead of network allowlisting.
    }
  }

  deletion_protection = false

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "app" {
  project  = var.project_id
  name     = "ai_employee"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_database" "dbos" {
  project  = var.project_id
  name     = "ai_employee_dbos"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "app" {
  project  = var.project_id
  name     = "ai"
  instance = google_sql_database_instance.main.name
  password = var.db_password
}

# --- Secret Manager shells (values set out of band) -----------------------
resource "google_secret_manager_secret" "slack_signing_secret" {
  project   = var.project_id
  secret_id = "slack-signing-secret"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "slack_bot_token" {
  project   = var.project_id
  secret_id = "slack-bot-token"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}
