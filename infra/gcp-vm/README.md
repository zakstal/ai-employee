# infra/gcp-vm

Terraform for one always-on Compute Engine VM that runs the control plane, a
warm runner, and a Cloud SQL Auth Proxy via `docker compose`, fronted by
Caddy for automatic HTTPS on an sslip.io hostname (no domain needed).

This is an alternative to `infra/gcp-cloudrun`'s Cloud Run control-plane
service, for a "warm runner" deployment shape (a runner process kept alive
between tasks instead of a fresh Cloud Run Job execution per run). It
**reuses** everything `infra/gcp-cloudrun` already created --  Cloud SQL
instance `ai-employee-pg`, the Secret Manager secrets, the Artifact
Registry repo, and the `ai-employee-runner`/`ai-employee-runner-ops` Cloud
Run Jobs -- by name, via plain string interpolation. It does not create or
modify any of those, and does not touch the Cloud Run service.

- **VM** (`${name}-vm`): `google_compute_instance` on `debian-cloud/debian-12`
  (not Container-Optimized OS -- see `main.tf` comment), running Docker via a
  `metadata_startup_script`.
- **Static IP** (`${name}-vm-ip`): a `google_compute_address`, used both as
  the VM's external IP and to derive the sslip.io hostname
  (`34.1.2.3` -> `34-1-2-3.sslip.io`).
- **Firewall**: tcp/80 and tcp/443 open to `0.0.0.0/0` on the VM's tag.
  No SSH firewall rule unless `ssh_source_ranges` is set (see below).
- **Compose stack** on the VM: `cloudsql` (Cloud SQL Auth Proxy, TCP),
  `control-plane`, `runner` (in server/warm mode), `caddy` (automatic HTTPS).

## Bootstrap order

1. `infra/gcp-cloudrun` must already be applied -- this stack reads its
   Cloud SQL instance, secrets, and Artifact Registry repo by name and fails
   at VM boot (not at `terraform apply`) if they don't exist yet.
2. Build and push `control-plane` and `runner` images the same way as
   `infra/gcp-cloudrun`'s README (`docker buildx build --platform linux/amd64
   ... --push`), or reuse tags already pushed there.
3. `terraform init` (this stack has its own state, separate from
   `infra/gcp-cloudrun`'s).
4. `./apply.sh <control-plane-tag> <runner-tag>` -- reads `GCP_PROJECT` from
   `../../.env`, generates and persists `RUNNER_TOKEN` into `../../.env` on
   first run, and applies.
5. `terraform output -raw public_url` once the VM has finished its startup
   script (a minute or two for Docker + package installs on first boot,
   seconds on reboot) -- Caddy needs a few seconds itself to complete the
   ACME handshake for the sslip.io certificate.

## Cutover from Cloud Run

1. Register ClickUp's webhook and chat-automation URLs against the new
   `public_url` (they currently point at `infra/gcp-cloudrun`'s
   `service_url`).
2. Verify the VM is serving correctly (webhook round-trip, a manual
   ClickUp-triggered run) before turning the old path off.
3. Scale the Cloud Run control-plane service to zero so it stops serving
   (and billing for always-allocated CPU) without deleting it:
   ```bash
   gcloud run services update ai-employee-control-plane \
     --region us-central1 --min-instances=0
   ```
   Leaving the Cloud Run *Jobs* (`ai-employee-runner`, `ai-employee-runner-ops`)
   alone -- the VM's control plane still triggers `ai-employee-runner-ops` for
   Azure/az-cli tasks the warm runner doesn't handle.

## Rollback

Cutover only repoints two webhook URLs and a Cloud Run scaling flag -- none
of it is destructive:

```bash
gcloud run services update ai-employee-control-plane \
  --region us-central1 --min-instances=1
```

then point ClickUp's webhook/chat URLs back at
`infra/gcp-cloudrun`'s `service_url`. The VM can keep running (or
`terraform destroy` it here) without affecting Cloud SQL, secrets, or the
Artifact Registry repo -- this stack never owns those.

## Decisions this stack makes for you

- **Per-secret IAM, not a project-wide `secretmanager.secretAccessor`**: the
  VM's service account gets `google_secret_manager_secret_iam_member` on
  just the 7 secrets `startup.sh.tftpl` actually reads (`database-url`,
  `dbos-system-database-url`, `claude-code-oauth-token`,
  `clickup-api-token`, `clickup-webhook-secret`, `clickup-chat-secret`,
  `gh-token`) -- not `slack-*` or `azure-client-secret`, which nothing on
  this VM consumes.
- **SSH via OS Login + IAP, not a firewall hole**: `ssh_source_ranges`
  defaults to `[]`, which creates no SSH firewall rule at all. Reach the VM
  with `gcloud compute ssh --tunnel-through-iap` (the `ssh_hint` output)
  instead, which needs no open port -- only IAM (`roles/iap.tunnelResourceAccessor`
  plus OS Login on the caller's account). Set `ssh_source_ranges` only if
  IAP genuinely isn't available in your environment.
- **Secrets fetched at boot, not baked into the image**: `startup.sh.tftpl`
  pulls each secret's latest version via `gcloud secrets versions access` and
  skips it cleanly (no `.env` line) if no version exists yet, mirroring
  `infra/gcp-cloudrun/secrets.tf`'s "shell now, value later" pattern.
- **`DATABASE_URL`/`DBOS_SYSTEM_DATABASE_URL` are rewritten at boot**: the
  Secret Manager values are Cloud Run's socket form
  (`postgres://u:p@localhost/db?host=/cloudsql/<conn>`); the startup script
  `sed`s them into the Cloud SQL Auth Proxy's TCP form
  (`postgres://u:p@cloudsql:5432/db`) before writing `.env`. Nothing in
  Secret Manager itself changes.
- **Runner in server mode**: `RUNNER_MODE=server` + `RUNNER_PORT=8080` +
  `RUNNER_TOKEN` on the `runner` container switch the runner image's entrypoint
  (`apps/runner/dist/index.js`) into the warm HTTP server implemented in
  `apps/runner/src/server.ts`.
- **`sslip_host` computed once in `main.tf`**: both `outputs.tf` and
  `startup.sh.tftpl` read the same `local.sslip_host`, so the hostname in
  Caddy's config and the one you register with ClickUp can never drift
  apart.

## Cost note (us-central1, roughly)

- `e2-medium` VM, always on: **~$25/mo**.
- Static IP: free while attached to a running instance; ~$3/mo if you stop
  the VM and leave the IP reserved but unattached.
- Cloud SQL, Secret Manager, Artifact Registry: unchanged -- owned and
  billed under `infra/gcp-cloudrun`, not duplicated here.
- No load balancer: Caddy on the VM terminates TLS directly.
