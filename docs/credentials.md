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

- Installation tokens last exactly one hour and cannot be extended. A run longer than that loses `git` and `gh` unless the token is refreshed (a later change); keep such roles on a `secret` token meanwhile.
- GitHub Packages' npm registry has historically not accepted installation tokens. If `npm install` of a private `@scope` package fails, keep a separate `secret` login that sets only `NPM_GITHUB_TOKEN` and list `env: [GH_TOKEN]` on the app login.
- App tokens cannot call `gh api user`; use `gh api repos/<owner>/<repo>` to test.
