variable "project_id" {
  type        = string
  description = "GCP project to deploy into."
  default     = "my-gcp-project"
}

variable "region" {
  type        = string
  description = "Region for Cloud Run, Artifact Registry, and Cloud SQL."
  default     = "us-central1"
}

variable "name" {
  type        = string
  description = "Base name used for the control-plane service, runner job, Artifact Registry repo, and related resources."
  default     = "ai-employee"
}

variable "db_tier" {
  type        = string
  description = "Cloud SQL machine tier."
  default     = "db-f1-micro"
}

variable "db_password" {
  type        = string
  description = "Password for the 'ai' Cloud SQL user. Set out of band (e.g. TF_VAR_db_password or a .tfvars file kept out of git)."
  sensitive   = true
}

variable "control_plane_image" {
  type        = string
  description = "Full Artifact Registry image URL for the control plane, e.g. us-central1-docker.pkg.dev/<project>/ai-employee/control-plane:<tag>."
}

variable "runner_image" {
  type        = string
  description = "Full Artifact Registry image URL for the runner, e.g. us-central1-docker.pkg.dev/<project>/ai-employee/runner:<tag>."
}

variable "min_instances" {
  type        = number
  description = <<-EOT
    Minimum Cloud Run instance count for the control plane. Use 1 when this
    stack is the live control plane (DBOS runs workflows in-process; scale-to-zero
    would suspend them mid-workflow). Use 0 to park this stack while the VM stack
    (infra/gcp-vm) is live — it then costs nothing but stays deployable.
  EOT
  default     = 0 # parked: the VM stack (infra/gcp-vm) is live
}

variable "public_base_url" {
  type        = string
  description = <<-EOT
    Value for the control plane's PUBLIC_BASE_URL env var. Chicken-and-egg:
    the Cloud Run URL only exists after the service is first created. Leave
    "" on first apply (the app falls back to its own PUBLIC_BASE_URL default,
    which is harmless since nothing external depends on it yet), then set
    this to the `service_url` output and re-apply once you know it.
  EOT
  default     = ""
}

variable "env" {
  type        = map(string)
  description = <<-EOT
    Extra non-secret env vars for the control plane, merged over the computed
    defaults (GCP_PROJECT, GCP_REGION, CLOUDRUN_JOB_NAME, RUNNER_IMAGE,
    SANDBOX_RUNTIME, PORT) — a key here overrides the computed value. Use it
    for things this stack has no opinion on, e.g. DEFAULT_EMPLOYEE_ID.
  EOT
  default     = {}
}

# --- Secret Manager seed values -------------------------------------------
# All default to "" (create the secret shell, skip the initial version) so a
# first `terraform apply` never fails on a missing credential. Populate real
# values via TF_VAR_* from .env — see README.md.

variable "slack_signing_secret" {
  type        = string
  description = "Initial value for the slack-signing-secret Secret Manager secret. \"\" creates the secret shell only."
  sensitive   = true
  default     = ""
}

variable "slack_bot_token" {
  type        = string
  description = "Initial value for the slack-bot-token Secret Manager secret. \"\" creates the secret shell only."
  sensitive   = true
  default     = ""
}

variable "claude_code_oauth_token" {
  type        = string
  description = "Initial value for the claude-code-oauth-token Secret Manager secret. \"\" creates the secret shell only."
  sensitive   = true
  default     = ""
}

variable "clickup_api_token" {
  type        = string
  description = "Initial value for the clickup-api-token Secret Manager secret. \"\" creates the secret shell only."
  sensitive   = true
  default     = ""
}

variable "clickup_webhook_secret" {
  type        = string
  description = "Initial value for the clickup-webhook-secret Secret Manager secret. \"\" creates the secret shell only."
  sensitive   = true
  default     = ""
}

variable "clickup_chat_secret" {
  type        = string
  description = "Initial value for the clickup-chat-secret Secret Manager secret. \"\" creates the secret shell only."
  sensitive   = true
  default     = ""
}

variable "gh_token" {
  type        = string
  description = "Initial value for the gh-token Secret Manager secret. \"\" creates the secret shell only."
  sensitive   = true
  default     = ""
}

variable "azure_client_secret" {
  type        = string
  description = "Initial value for the azure-client-secret Secret Manager secret. \"\" creates the secret shell only."
  sensitive   = true
  default     = ""
}

variable "runner_ops_image" {
  description = "Full Artifact Registry URL of the runner-ops image (runner + Azure CLI)."
  type        = string
}
