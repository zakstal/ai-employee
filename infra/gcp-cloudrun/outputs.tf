output "service_url" {
  description = "Public URL of the control-plane Cloud Run service. Feed this back into -var=\"public_base_url=...\" and re-apply."
  value       = google_cloud_run_v2_service.control_plane.uri
}

output "cloudsql_connection_name" {
  value = google_sql_database_instance.main.connection_name
}

output "artifact_registry_url" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "control_plane_service_account_email" {
  value = google_service_account.control_plane.email
}

output "runner_service_account_email" {
  value = google_service_account.runner.email
}

output "runner_job_names" {
  value = [for j in google_cloud_run_v2_job.runner : j.name]
}
