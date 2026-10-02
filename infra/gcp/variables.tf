variable "project_id" {
  type        = string
  description = "GCP project to deploy into."
}

variable "region" {
  type        = string
  description = "Region for the GKE cluster, Artifact Registry repo, and Cloud SQL instance."
  default     = "us-central1"
}

variable "name" {
  type        = string
  description = "Base name used for the cluster, Artifact Registry repo, and related resources."
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

variable "employee_ids" {
  type        = list(string)
  description = <<-EOT
    Employee IDs the runner Workload Identity binding should cover, one per
    `ai-emp-<id>` namespace. The control plane creates these namespaces
    on demand (see packages/adapters/src/k8s-job.ts), so this list has to be
    kept in sync by re-running `terraform apply` when a new employee is added.
  EOT
  default     = ["dev"]
}
