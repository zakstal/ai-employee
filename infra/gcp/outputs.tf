output "cluster_name" {
  value = google_container_cluster.primary.name
}

output "cluster_location" {
  value = google_container_cluster.primary.location
}

output "artifact_registry_url" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "cloudsql_connection_name" {
  value = google_sql_database_instance.main.connection_name
}

output "control_plane_service_account_email" {
  value = google_service_account.control_plane.email
}

output "runner_service_account_email" {
  value = google_service_account.runner.email
}
