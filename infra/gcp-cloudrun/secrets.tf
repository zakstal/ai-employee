# --- Secret shells with a static seed value ---------------------------
# One map instead of eight repeated resource pairs: `google_secret_manager_secret`
# is created for every entry (the shell always exists so IAM bindings and
# `secret_key_ref`s never dangle), while `google_secret_manager_secret_version`
# is only created where a real value was supplied — an empty string means
# "set this out of band later" (see README.md) rather than writing an empty
# secret version.
locals {
  simple_secrets = {
    "slack-signing-secret"    = var.slack_signing_secret
    "slack-bot-token"         = var.slack_bot_token
    "claude-code-oauth-token" = var.claude_code_oauth_token
    "clickup-api-token"       = var.clickup_api_token
    "clickup-webhook-secret"  = var.clickup_webhook_secret
    "clickup-chat-secret"     = var.clickup_chat_secret
    "gh-token"                = var.gh_token
    "azure-client-secret"     = var.azure_client_secret
  }
  # Keys only: a for_each map may not carry sensitive values, so the version resource
  # looks the value up by key instead.
  simple_secret_keys_with_values = toset([for k, v in local.simple_secrets : k if nonsensitive(v) != ""])
}

resource "google_secret_manager_secret" "simple" {
  for_each = local.simple_secrets

  project   = var.project_id
  secret_id = each.key

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "simple" {
  for_each = local.simple_secret_keys_with_values

  secret      = google_secret_manager_secret.simple[each.key].id
  secret_data = local.simple_secrets[each.key]
}

# --- Secret shells without any value --------------------------------------
# Created empty (no version resource), so values added later with `gcloud secrets versions add` never
# enter variables or state. Each gets the same replication as the secrets above.
resource "google_secret_manager_secret" "shell" {
  for_each = var.secret_shells

  project   = var.project_id
  secret_id = each.key

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

# --- Database URLs, built from the Cloud SQL connection name --------------
# `localhost` is a placeholder so the string is a valid WHATWG URL (DBOS runs `new URL()` on it);
# the pg driver honours `?host=/cloudsql/...` and ignores the placeholder.
resource "google_secret_manager_secret" "database_url" {
  project   = var.project_id
  secret_id = "database-url"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgres://ai:${var.db_password}@localhost/ai_employee?host=/cloudsql/${google_sql_database_instance.main.connection_name}"
}

resource "google_secret_manager_secret" "dbos_system_database_url" {
  project   = var.project_id
  secret_id = "dbos-system-database-url"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "dbos_system_database_url" {
  secret      = google_secret_manager_secret.dbos_system_database_url.id
  secret_data = "postgres://ai:${var.db_password}@localhost/ai_employee_dbos?host=/cloudsql/${google_sql_database_instance.main.connection_name}"
}
