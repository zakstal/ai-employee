locals {
  vm_name  = "${var.name}-vm"
  vm_tag   = "${var.name}-vm"
  vm_sa_id = "${var.name}-vm"

  # Existing runner SA from infra/gcp-cloudrun (iam.tf: google_service_account.runner,
  # account_id = "${var.name}-runner"). Referenced by plain string interpolation rather
  # than a data source -- the email is fully determined by var.name + var.project_id, no
  # extra API round trip needed to look it up.
  runner_sa_email = "${var.name}-runner@${var.project_id}.iam.gserviceaccount.com"

  # sslip.io hostname derived from the static IP, e.g. 34.1.2.3 -> 34-1-2-3.sslip.io.
  # Computed once here (not in startup.sh.tftpl) so outputs.tf and the startup script
  # can't drift from each other.
  sslip_host = "${replace(google_compute_address.vm.address, ".", "-")}.sslip.io"

  # Secrets this VM actually reads (see startup.sh.tftpl) -- created by
  # infra/gcp-cloudrun's secrets.tf, reused here by name. Scoped per-secret IAM below
  # rather than a project-wide roles/secretmanager.secretAccessor, since the VM has no
  # business reading slack-signing-secret, azure-client-secret, etc.
  vm_secret_ids = concat([
    "database-url",
    "dbos-system-database-url",
    "claude-code-oauth-token",
    "clickup-api-token",
    "clickup-webhook-secret",
    "clickup-chat-secret",
    "gh-token",
  ], tolist(var.secret_shells))
}

# --- Static external IP -----------------------------------------------
resource "google_compute_address" "vm" {
  project = var.project_id
  region  = var.region
  name    = "${var.name}-vm-ip"
}

# --- Service account -----------------------------------------------------
resource "google_service_account" "vm" {
  project      = var.project_id
  account_id   = local.vm_sa_id
  display_name = "AI Employee VM (control plane + warm runner)"
}

resource "google_project_iam_member" "vm" {
  for_each = toset([
    "roles/artifactregistry.reader", # pull control-plane/runner images
    "roles/cloudsql.client",         # cloud-sql-proxy sidecar
    "roles/run.developer",           # trigger the runner-ops Cloud Run Job (Azure tasks)
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.vm.email}"
}

# Per-secret secretAccessor instead of a project-wide grant -- see vm_secret_ids above.
resource "google_secret_manager_secret_iam_member" "vm" {
  for_each = toset(local.vm_secret_ids)

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}

# The VM's SA triggers executions of the existing runner-ops Cloud Run Job (for
# Azure/az-cli tasks the warm runner itself doesn't handle), which run *as* the
# runner SA -- that needs actAs on it, same as the control-plane SA in gcp-cloudrun/iam.tf.
resource "google_service_account_iam_member" "vm_acts_as_runner" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${local.runner_sa_email}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.vm.email}"
}

# --- Firewall --------------------------------------------------------------
resource "google_compute_firewall" "vm_http_https" {
  project = var.project_id
  name    = "${var.name}-vm-allow-http-https"
  network = "default"

  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = [local.vm_tag]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

# No SSH firewall rule by default (var.ssh_source_ranges = []): the intended access
# path is `gcloud compute ssh --tunnel-through-iap`, which needs OS Login/IAP
# permissions on the caller's account, not an open port 22.
resource "google_compute_firewall" "vm_ssh" {
  count = length(var.ssh_source_ranges) > 0 ? 1 : 0

  project = var.project_id
  name    = "${var.name}-vm-allow-ssh"
  network = "default"

  direction     = "INGRESS"
  source_ranges = var.ssh_source_ranges
  target_tags   = [local.vm_tag]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# --- VM --------------------------------------------------------------------
# Plain debian-cloud/debian-12, not Container-Optimized OS: COS's read-only rootfs
# and toolbox-only shell make it a poor fit for a docker-compose stack we edit and
# restart via systemd/gcloud ssh. Debian gives a normal apt-managed Docker install.
resource "google_compute_instance" "vm" {
  project      = var.project_id
  zone         = var.zone
  name         = local.vm_name
  machine_type = var.machine_type
  tags         = [local.vm_tag]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      type  = "pd-balanced"
      size  = var.disk_gb
    }
  }

  network_interface {
    network = "default"

    access_config {
      nat_ip = google_compute_address.vm.address
    }
  }

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }

  # `startup-script` as a plain metadata key updates IN PLACE. The dedicated
  # `metadata_startup_script` attribute forces instance replacement on every change
  # (it destroyed the VM once — 5 min outage + zone capacity roulette). A deploy is:
  # apply (metadata update) → `google_metadata_script_runner startup` on the box,
  # which rewrites compose and restarts only the containers whose image changed.
  metadata = {
    startup-script = templatefile("${path.module}/startup.sh.tftpl", {
      project_id               = var.project_id
      region                   = var.region
      name                     = var.name
      control_plane_image      = var.control_plane_image
      runner_image             = var.runner_image
      cloudsql_connection_name = var.cloudsql_connection_name
      runner_token             = var.runner_token
      host                     = local.sslip_host
      env                      = var.env
      azbroker_image           = var.azbroker_image
      azure_broker_secret      = var.azure_broker_secret
      azure_tenant_id          = var.azure_tenant_id
      azure_subscription_id    = var.azure_subscription_id
    })
  }

  allow_stopping_for_update = true

  depends_on = [
    google_project_iam_member.vm,
    google_secret_manager_secret_iam_member.vm,
    google_service_account_iam_member.vm_acts_as_runner,
  ]
}
