import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";

/**
 * Pre-spawn tool logins driven purely by injected env. Non-fatal: a failed
 * login is reported to stderr and the agent proceeds (it will see the tool
 * unauthenticated and say so). Secrets never appear in argv where possible.
 */
export function bootstrapTools(env: NodeJS.ProcessEnv, run = spawnSync): string[] {
  const notes: string[] = [];

  if (env.AZURE_CLIENT_ID && env.AZURE_TENANT_ID && env.AZURE_CLIENT_SECRET) {
    const r = run(
      "az",
      ["login", "--service-principal", "-u", env.AZURE_CLIENT_ID, "--tenant", env.AZURE_TENANT_ID, "-p", env.AZURE_CLIENT_SECRET, "--output", "none"],
      { env, stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 },
    );
    if (r.status === 0) {
      notes.push("az: logged in as service principal");
      if (env.AZURE_SUBSCRIPTION_ID) run("az", ["account", "set", "--subscription", env.AZURE_SUBSCRIPTION_ID], { env, stdio: "ignore" });
    } else notes.push(`az: login failed: ${String(r.stderr ?? "").trim().slice(0, 300) || r.error?.message || "unknown"}`);
  }

  // Token broker (App Service managed-identity protocol): `az login --identity` fetches tokens from it on demand.
  if (env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER && !env.AZURE_CLIENT_SECRET) {
    const r = run("az", ["login", "--identity", "--allow-no-subscriptions", "--output", "none"], { env, stdio: ["ignore", "ignore", "pipe"], timeout: 90_000 });
    if (r.status === 0) {
      notes.push("az: logged in via token broker");
      if (env.AZURE_SUBSCRIPTION_ID) run("az", ["account", "set", "--subscription", env.AZURE_SUBSCRIPTION_ID], { env, stdio: "ignore" });
    } else notes.push(`az: broker login failed: ${String(r.stderr ?? "").trim().slice(0, 300) || r.error?.message || "unknown"}`);
  }

  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    const r = run("gcloud", ["auth", "activate-service-account", "--key-file", env.GOOGLE_APPLICATION_CREDENTIALS, "--quiet"], { env, stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 });
    notes.push(r.status === 0 ? "gcloud: service account activated" : `gcloud: activation failed: ${String(r.stderr ?? "").trim().slice(0, 300)}`);
  }

  // gh reads GH_TOKEN directly. Make git use it too, and give commits an identity.
  if (env.GH_TOKEN) {
    run("git", ["config", "--global", "credential.helper", "!gh auth git-credential"], { env, stdio: "ignore" });
    run("git", ["config", "--global", "user.name", env.GIT_AUTHOR_NAME ?? "Dev Bot"], { env, stdio: "ignore" });
    run("git", ["config", "--global", "user.email", env.GIT_AUTHOR_EMAIL ?? "devbot@users.noreply.github.com"], { env, stdio: "ignore" });
    notes.push("git: credential helper → gh");
  }

  // Image-specific setup hook: derived images drop executables into this dir (default /etc/ai-employee/bootstrap.d)
  // and each runs once, in name order, before the agent starts. Each one's last stdout line is reported.
  const hookDir = env.BOOTSTRAP_D_DIR ?? "/etc/ai-employee/bootstrap.d";
  if (existsSync(hookDir)) {
    for (const name of readdirSync(hookDir).sort()) {
      const file = `${hookDir}/${name}`;
      if (!statSync(file).isFile() || !(statSync(file).mode & 0o111)) continue;
      const r = run(file, [], { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 60_000 });
      notes.push(String(r.stdout ?? "").trim().split("\n").pop() || `bootstrap.d/${name}: failed: ${String(r.stderr ?? "").trim().slice(0, 300) || r.error?.message || "unknown"}`);
    }
  }

  // Clone the role's repos into the workspace.
  if (env.REPOS) {
    let repos: Array<{ url: string; ref?: string; path?: string }> = [];
    try {
      repos = JSON.parse(env.REPOS) as typeof repos;
    } catch {
      notes.push("repos: REPOS is not valid JSON, skipped");
    }
    const workspace = env.WORKSPACE_DIR ?? "/workspace";
    for (const r of repos) {
      const name = r.path ?? (r.url.split("/").pop() ?? "repo").replace(/\.git$/, "");
      const dir = `${workspace}/${name}`;
      if (existsSync(`${dir}/.git`)) {
        // Persistent workspace (one per conversation): refresh instead of re-cloning. Local edits win; a
        // non-fast-forward just leaves the checkout where the previous run left it.
        const res = run("git", ["-C", dir, "pull", "-q", "--ff-only"], { env, stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 });
        notes.push(res.status === 0 ? `repos: refreshed ${name}` : `repos: ${name} kept as-is (pull: ${String(res.stderr ?? "").trim().slice(0, 120)})`);
        continue;
      }
      const args = ["clone", "--depth", "50", ...(r.ref ? ["--branch", r.ref] : []), r.url, dir];
      const res = run("git", args, { env, stdio: ["ignore", "ignore", "pipe"], timeout: 180_000 });
      notes.push(res.status === 0 ? `repos: cloned ${r.url} → ${name}` : `repos: clone failed ${r.url}: ${String(res.stderr ?? "").trim().slice(0, 200)}`);
    }
  }
  return notes;
}
