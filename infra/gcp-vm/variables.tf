variable "project_id" {
  type        = string
  description = "GCP project to deploy into."
}

variable "region" {
  type        = string
  description = "Region for the static IP."
  default     = "us-central1"
}

variable "zone" {
  type        = string
  description = "Zone for the Compute Engine VM."
  default     = "us-central1-b"
}

variable "name" {
  type        = string
  description = "Base name for the VM, its service account, and the firewall rule. Also used as CLOUDRUN_JOB_PREFIX so the control plane finds the runner Jobs created by infra/gcp-cloudrun (they share this name)."
  default     = "ai-employee"
}

variable "machine_type" {
  type        = string
  description = "Machine type for the VM."
  default     = "e2-medium"
}

variable "disk_gb" {
  type        = number
  description = "Boot disk size in GB."
  default     = 30
}

variable "control_plane_image" {
  type        = string
  description = "Full Artifact Registry image URL for the control plane, e.g. us-central1-docker.pkg.dev/<project>/ai-employee/control-plane:<tag>. Reuses the Artifact Registry repo created by infra/gcp-cloudrun."
}

variable "runner_image" {
  type        = string
  description = "Full Artifact Registry image URL for the warm runner, e.g. us-central1-docker.pkg.dev/<project>/ai-employee/runner:<tag>."
}

variable "cloudsql_connection_name" {
  type        = string
  description = "Cloud SQL instance connection name for the ai-employee-pg instance created by infra/gcp-cloudrun (<project>:<region>:<instance>). This stack does not create or manage that instance."
}

variable "runner_token" {
  type        = string
  description = "Shared secret between the control plane and the warm runner's HTTP API (RUNNER_TOKEN on both sides). Generate with e.g. `openssl rand -base64 32`; apply.sh does this for you."
  sensitive   = true
}

variable "env" {
  type        = map(string)
  description = "Extra env vars for the control plane container, merged into /opt/ai-employee/.env alongside the computed defaults (PORT, PUBLIC_BASE_URL, SANDBOX_RUNTIME, WARM_RUNNER_URL, RUNNER_TOKEN, GCP_PROJECT, GCP_REGION, CLOUDRUN_JOB_PREFIX, ROLES_DIR). Use it for things this stack has no opinion on, e.g. DEFAULT_EMPLOYEE_ID, CLICKUP_TEAM_ID."
  default     = {}
}

variable "ssh_source_ranges" {
  type        = list(string)
  description = "CIDR ranges allowed to SSH to the VM on tcp/22. Empty (default) creates no SSH firewall rule at all -- use `gcloud compute ssh --tunnel-through-iap` (OS Login/IAP) instead, which needs no open port. Only set this if IAP is unavailable and a direct SSH firewall hole is genuinely required."
  default     = []
}

variable "azbroker_image" {
  description = "Azure token broker image (infra/azbroker). Empty string disables the sidecar."
  type        = string
  default     = ""
}

variable "azure_broker_secret" {
  description = "Shared secret between the control plane / runner and the Azure token broker."
  type        = string
  sensitive   = true
  default     = ""
}

variable "azure_tenant_id" {
  type    = string
  default = ""
}

variable "azure_subscription_id" {
  type    = string
  default = ""
}

variable "secret_shells" {
  description = "Extra Secret Manager secrets the VM may read, created empty by infra/gcp-cloudrun (same variable there). Apply gcp-cloudrun first."
  type        = set(string)
  default     = []
}
