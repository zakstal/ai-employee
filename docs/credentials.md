# Per-employee credentials

An employee file can define named logins under `credentials:`. A role lists the names it may use as `grants:` (the older `credentials: [...]` list on a role is still read as `grants`). Values never appear in YAML: only Secret Manager names, ids, or nothing at all.

```yaml
credentials:
  claude:
    kind: secret
    env: { CLAUDE_CODE_OAUTH_TOKEN: { secret: claude-code-oauth-token } }
  clickup:
    kind: secret
    for: clickup                       # what the login is for; drives the environment footer
    env:
      CLICKUP_API_TOKEN: { secret: clickup-api-token }
      CLICKUP_TEAM_ID: { value: "1234567" }   # non-secret ids are inline
roles:
  - id: implement
    grants: [claude, clickup]
```

A grant name the employee does not define falls back to the built-in login of that name (`anthropic`, `claude-subscription`, `clickup`, `github`, `azure`, `azure-user`, `vertex`), read from the control plane's own environment. An employee with no `credentials:` map behaves exactly as before. A defined login of the same name wins over the built-in.

Credentials are resolved per task when the sandbox starts, not when the run spec is built, so no credential value is stored in the workflow engine's records.

## Kinds

| kind | what it is |
|---|---|
| `secret` | env vars from inline `value`s or `secret` references. `optional: true` on a reference skips it when the secret has no version; otherwise a missing value fails the task |
| `minted` | a GitHub App installation token minted for each task (provider `github-app`) |
| `federated` | no secret: a token exchange (provider `azure`) |
| `broker` | a person's delegated login held by a token broker (provider `azure`) |

`SECRET_STORE=gcp` reads `secret` references from Secret Manager in `GCP_PROJECT`, using the control plane's own service account (it needs `secretAccessor` on each secret). `SECRET_STORE=env` (the default) reads `SECRET_<NAME>` environment variables, dashes as underscores.

## GitHub App (`minted`)

```yaml
credentials:
  github:
    kind: minted
    provider: github-app
    appId: "1000001"
    installationId: "20000002"
    privateKey: { secret: github-app-private-key }
    permissions: { contents: write, pull_requests: write, issues: write, checks: read, actions: read, metadata: read }
    repositories: [repo-a, repo-b]     # optional: narrow below the installation
    env: [GH_TOKEN, NPM_GITHUB_TOKEN]  # default; names the token is exported as
    gitAuthor: { name: "my-bot[bot]", email: "1000001+my-bot[bot]@users.noreply.github.com" }
```

Create the app once (an organisation owner does this):

1. Organisation settings, Developer settings, GitHub Apps, New GitHub App. Webhook inactive; installable only on this account.
2. Repository permissions: Contents, Pull requests, Issues read and write; Metadata, Checks, Actions, Commit statuses read. Grant no Workflows, Administration or organisation permission.
3. Generate a private key, note the App ID, and store the PEM as the secret named in `privateKey`.
4. Install the app on the organisation, "Only select repositories". The installation id is the trailing number of the installation's settings URL.
5. Keep the app out of every branch-protection bypass list and require a review on the default branch, so "never merge, never push to main" stays enforced by GitHub.
6. Bot identity for commits: `gh api users/<app-slug>%5Bbot%5D --jq .id` gives the id for the `gitAuthor` email.

Limits to know:

- Installation tokens last exactly one hour and cannot be extended. A run longer than that keeps working because the runner re-fetches a token (see "Runs longer than a token lives").
- GitHub Packages' npm registry has historically not accepted installation tokens. If `npm install` of a private `@scope` package fails, keep a separate `secret` login that sets only `NPM_GITHUB_TOKEN` and list `env: [GH_TOKEN]` on the app login.
- App tokens cannot call `gh api user`; use `gh api repos/<owner>/<repo>` to test.

## Azure without a secret (`federated`)

```yaml
credentials:
  azure-read:
    kind: federated
    provider: azure
    tenantId: "<tenant guid>"
    clientId: "<app registration client id>"      # not a secret
    subscriptionId: "<subscription guid>"          # optional
    audience: api://AzureADTokenExchange           # default
    exchange: runner                               # default. control-plane: used by monitors, sets nothing in a run
```

The sandbox asks the Google metadata server for an ID token for its own service account (with `audience`) and trades it at Entra for an Azure session (`az login --federated-token`, done by the runner before the agent starts). No secret is stored anywhere. It works where the metadata server is reachable: Cloud Run jobs, and the warm runner on a GCP VM.

One-time Azure setup (needs Entra Application Developer or higher, and Owner or User Access Administrator on the subscription):

```bash
az login
SUB=<subscription guid>
TENANT=$(az account show --query tenantId -o tsv)
APP_ID=$(az ad app create --display-name "ai-employee" --sign-in-audience AzureADMyOrg --query appId -o tsv)
az ad sp create --id $APP_ID
# subject = the numeric unique id of each GCP service account that will ask for the token (not its email)
SA_ID=$(gcloud iam service-accounts describe <runner-sa-email> --format='value(uniqueId)')
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "gcp-runner-sa", "issuer": "https://accounts.google.com", "subject": "'"$SA_ID"'",
  "audiences": ["api://AzureADTokenExchange"]}'
az role assignment create --assignee $APP_ID --role "Reader" --scope /subscriptions/$SUB
az role assignment create --assignee $APP_ID --role "Monitoring Reader" --scope /subscriptions/$SUB
```

`clientId` and `tenantId` go in the employee file. Federated credentials take a few minutes to become usable. To see what Azure sees, run this from inside a runner and compare `iss`, `sub`, `aud` with the credential:

```bash
curl -s -H 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=api://AzureADTokenExchange&format=full'
```

Isolation: the Google token proves "this is service account X", not "this is employee Y". Employees that share a service account (everything on the shared warm runner, or on one Cloud Run job) can present each other's tokens to any app registration that trusts that account. For real separation give each employee its own Cloud Run jobs and service account (an `extra_runner_images` entry with its own `service_account`), set `sandbox: { jobPrefix: <employee> }` in the employee file so `imageRef` roles use those jobs, and add one federated credential per service account on that employee's app registration.

Azure access tokens from `--federated-token` last about an hour and `az` cannot refresh them. Roles that run longer need a re-login (a later change) or another login kind.

## Delegated Azure login (`broker`)

```yaml
credentials:
  azure-user:
    kind: broker
    provider: azure
    url: http://azbroker:8081
    secret: { secret: azure-broker-secret-alice }   # this employee's key
    tenantId: "<tenant guid>"
    subscriptionId: "<subscription guid>"
```

The broker (`infra/azbroker`) holds one `az login` per employee. Set `BROKER_SECRETS='{"alice":"<key>","bob":"<key>"}'`; each key selects its employee and that employee's login home (`$AZURE_CONFIG_DIR/<employee>`). Log in once per employee: `docker exec -it <broker container> sh -c 'AZURE_CONFIG_DIR=/azure/alice az login --use-device-code'`. The single `BROKER_SECRET` still works as employee `default` using the volume root, so an existing deployment is unchanged. The broker is reachable from the warm runner on the VM network, not from Cloud Run jobs.

## Monitors

A monitor may name one of the employee's `broker` or `federated` credentials with `credential:`; the azure-errors collector then signs in with it. A `federated` one uses the control plane's own Google identity, so its Entra app needs a federated credential for the control plane's service account. Without `credential:` the collector reads the global `AZURE_*` variables, as before.

## Managing secrets

```bash
node apps/control-plane/dist/cli/credentials.js set   <employee> <grant> [--env NAME] [--from-file key.pem] --project <gcp project>
node apps/control-plane/dist/cli/credentials.js list  <employee> --project <gcp project>
node apps/control-plane/dist/cli/credentials.js check <employee> [grant] --project <gcp project>
```

`set` reads the value from stdin or `--from-file` (never argv) and adds a new Secret Manager version for the secret the login references (`--env` picks one when a login has several). The secret must already exist as an empty shell. `list` shows each login, its env names and the latest version of its secrets. `check` does the real resolve (it mints a GitHub App token, for instance) and prints env names and expiry, never values; it exits 1 on failure. All take `--dir <config dir>`; `check` takes `--store env` to read `SECRET_<NAME>` instead of Secret Manager.

## Runs longer than a token lives

A role granted a `minted` GitHub login gets `GH_TOKEN_REFRESH=<grant>` and `CONTROL_PLANE_URL` in its run env. In the runner image, git uses the `ai-employee-credential git` credential helper and `/usr/local/bin/gh` is a wrapper that exports a fresh `GH_TOKEN` before calling the real `gh`. Both call `POST /credentials/<grant>/refresh` with the run token, cache the answer in a 0600 file until five minutes before it expires, and so keep working past the first hour. The route answers only for a grant the run's role holds, only for refreshable kinds (`minted`), at most 60 times per run. Env vars already exported to child processes keep their first token; tools that read `GH_TOKEN` directly instead of through `gh` or git must be started after a refresh.

Not covered: a `federated` Azure session also lasts about an hour; its re-login helper is not built.
