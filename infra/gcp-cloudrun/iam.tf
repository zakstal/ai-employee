# --- control-plane GSA -----------------------------------------------------
resource "google_service_account" "control_plane" {
  project      = var.project_id
  account_id   = "${var.name}-control-plane"
  display_name = "AI Employee control plane (Cloud Run)"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "control_plane" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/secretmanager.secretAccessor",
    "roles/run.developer", # lets the control plane start/override the runner Job
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# The control plane triggers Job executions that run *as* the runner SA, so
# it needs actAs on that SA (without this, starting the Job fails even with
# roles/run.developer).
resource "google_service_account_iam_member" "control_plane_acts_as_runner" {
  service_account_id = google_service_account.runner.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.control_plane.email}"
}

# --- runner GSA --------------------------------------------------------
# Nothing extra by default: the runner only needs whatever a given sandbox
# run touches, and that isn't known at the infra layer yet. Add project IAM
# bindings here as real runner permissions get identified.
resource "google_service_account" "runner" {
  project      = var.project_id
  account_id   = "${var.name}-runner"
  display_name = "AI Employee runner (Cloud Run Job)"

  depends_on = [google_project_service.apis]
}
