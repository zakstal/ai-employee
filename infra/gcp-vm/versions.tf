terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.2" # latest per Terraform Registry MCP as of writing (8.2.0); matches infra/gcp-cloudrun
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
