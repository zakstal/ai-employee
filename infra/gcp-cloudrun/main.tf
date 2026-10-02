locals {
  apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(local.apis)

  project                    = var.project_id
  service                    = each.value
  disable_dependent_services = false
  disable_on_destroy         = false
}

# --- Artifact Registry -----------------------------------------------------
resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = var.name
  format        = "DOCKER"
  description   = "Control-plane and runner images for ${var.name}"

  # Every deploy pushes three images, so the repository grows without bound. Keep the last ten
  # versions per package (covers anything deployed or worth rolling back to), drop build leftovers
  # quickly, and cap the long tail. Keep rules take precedence over delete rules.
  cleanup_policies {
    id     = "keep-recent-10"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  cleanup_policies {
    id     = "delete-untagged-after-3d"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "3d"
    }
  }

  cleanup_policies {
    id     = "delete-anything-after-30d"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "30d"
    }
  }

  depends_on = [google_project_service.apis]
}

# --- Cloud SQL ---------------------------------------------------------
# Public IP, no authorized networks: Cloud Run reaches Postgres over the
# Cloud SQL Unix-domain socket at /cloudsql/<connection_name> (see the
# `cloud_sql_instance` volume on the control-plane service in cloudrun.tf),
# which authenticates via the Cloud SQL Auth Proxy built into Cloud Run
# rather than a network allowlist. Nothing else is allowlisted to hit the
# public IP directly.
resource "google_sql_database_instance" "main" {
  project          = var.project_id
  name             = "${var.name}-pg"
  region           = var.region
  database_version = "POSTGRES_17"

  settings {
    edition = "ENTERPRISE" # db-f1-micro / shared-core tiers only exist in the Enterprise edition
    tier    = var.db_tier

    ip_configuration {
      ipv4_enabled = true
      # No authorized_networks block on purpose (see comment above).
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
