# --- control-plane GSA: bound for Workload Identity to k8s SA
# ai-employee/control-plane (see infra/k8s/rbac.yaml) --------------------
resource "google_service_account" "control_plane" {
  project      = var.project_id
  account_id   = "ai-employee-control-plane"
  display_name = "AI Employee control plane"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "control_plane" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/secretmanager.secretAccessor",
    "roles/aiplatform.user",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_service_account_iam_member" "control_plane_workload_identity" {
  service_account_id = google_service_account.control_plane.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[ai-employee/control-plane]"
}

# --- runner GSA: bound for Workload Identity to k8s SA `runner` in every
# ai-emp-<employee_id> namespace (see infra/k8s/runner-serviceaccount.yaml).
# Namespaces are created on demand by KubernetesJobRuntime.start(), so
# var.employee_ids has to be kept in sync by hand. -------------------------
resource "google_service_account" "runner" {
  project      = var.project_id
  account_id   = "ai-employee-runner"
  display_name = "AI Employee runner (per-employee sandbox)"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "runner_aiplatform" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.runner.email}"
}

resource "google_service_account_iam_member" "runner_workload_identity" {
  for_each = toset(var.employee_ids)

  service_account_id = google_service_account.runner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[ai-emp-${each.value}/runner]"
}
