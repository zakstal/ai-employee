output "public_url" {
  description = "Public HTTPS URL Caddy serves (sslip.io hostname derived from the static IP)."
  value       = "https://${local.sslip_host}"
}

output "external_ip" {
  description = "Static external IP address of the VM."
  value       = google_compute_address.vm.address
}

output "instance_name" {
  value = google_compute_instance.vm.name
}

output "ssh_hint" {
  description = "Command to reach the VM without an open SSH port (OS Login + IAP tunnel)."
  value       = "gcloud compute ssh --zone ${var.zone} ${google_compute_instance.vm.name} --tunnel-through-iap"
}

output "zone" {
  value = var.zone
}
