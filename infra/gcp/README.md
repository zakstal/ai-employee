# infra/gcp

Terraform for the ai-employee control plane: GKE Autopilot, Artifact Registry,
Cloud SQL Postgres 17, service accounts, and empty Secret Manager secret
shells. Provider: `hashicorp/google` `~> 8.2` (latest at time of writing,
verified via the Terraform Registry MCP).

## Networking decision: Cloud SQL is public IP, no authorized networks

Private IP requires a VPC, a reserved peering range, and a
`google_service_networking_connection` — real infrastructure and a slow first
apply for a "small service." Instead this Cloud SQL instance has
`ipv4_enabled = true` and no `authorized_networks`, meaning nothing is
allowlisted to hit the public IP directly. **The control-plane pod must
connect through the Cloud SQL Auth Proxy sidecar (or the Cloud SQL Node.js
connector in-process)**, which authenticates over IAM rather than network
allowlisting. `infra/k8s/deployment.yaml` does not wire up a proxy sidecar
container — add one (`gcr.io/cloud-sql-connectors/cloud-sql-proxy`) if you
want the simplest path, or switch `DATABASE_URL`/`DBOS_SYSTEM_DATABASE_URL` to
use the connector library instead of a bare `postgres://` URL.

## Bootstrap sequence

```bash
# 1. Auth
gcloud auth login
gcloud auth application-default login
gcloud config set project <PROJECT_ID>

# 2. Terraform
cd infra/gcp
terraform init
terraform apply \
  -var="project_id=<PROJECT_ID>" \
  -var="db_password=<STRONG_PASSWORD>" \
  -var="employee_ids=[\"dev\"]"

# 3. Cluster credentials
gcloud container clusters get-credentials ai-employee --region us-central1 --project <PROJECT_ID>

# 4. Build + push both images (Artifact Registry URL is a terraform output)
REGISTRY=$(terraform output -raw artifact_registry_url)
gcloud auth configure-docker "${REGISTRY%%/*}"

docker build -f apps/control-plane/Dockerfile -t "$REGISTRY/control-plane:latest" .
docker push "$REGISTRY/control-plane:latest"

docker build -f apps/runner/Dockerfile -t "$REGISTRY/runner:latest" .
docker push "$REGISTRY/runner:latest"

# 5. Secrets (values set out of band, not by Terraform)
echo -n "<slack signing secret>" | gcloud secrets versions add slack-signing-secret --data-file=-
echo -n "<slack bot token>"      | gcloud secrets versions add slack-bot-token --data-file=-

# 6. Kubernetes manifests
# Replace PROJECT_ID / REGION placeholders in infra/k8s/*.yaml first (see comments in each file),
# then edit configmap.example.yaml / secret.example.yaml into real configmap.yaml / secret.yaml
# (DATABASE_URL / DBOS_SYSTEM_DATABASE_URL point at the Cloud SQL Auth Proxy — see above).
kubectl apply -f infra/k8s/namespace.yaml
kubectl apply -f infra/k8s/rbac.yaml
kubectl apply -f infra/k8s/configmap.yaml
kubectl apply -f infra/k8s/secret.yaml
kubectl apply -f infra/k8s/deployment.yaml
kubectl apply -f infra/k8s/service.yaml
kubectl apply -f infra/k8s/ingress.yaml
kubectl apply -f infra/k8s/runner-serviceaccount.yaml
```

## Cost note

- GKE Autopilot has no cluster management fee; you're billed per pod
  (vCPU/memory/storage requested by scheduled pods), so an idle namespace
  with no running Jobs costs ~nothing beyond the always-on control-plane pod.
- Cloud SQL `db-f1-micro` is ~$10/month (single zone, no HA), plus a few
  dollars for the 10GB default disk and public IP.
