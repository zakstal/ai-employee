import type { Config } from "../config.js";

/**
 * The built-in grants: static env copied from the control plane's own config. An employee with no
 * `credentials` map (or a grant name it does not define) resolves through here, exactly as before.
 */
export function legacyEnv(grant: string, config: Config): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: keyof Config, as = k as string) => {
    const v = config[k];
    if (typeof v === "string" && v) out[as] = v;
  };
  switch (grant) {
    case "anthropic": put("ANTHROPIC_API_KEY"); break;
    case "claude-subscription": put("CLAUDE_CODE_OAUTH_TOKEN"); break;
    case "clickup": put("CLICKUP_API_TOKEN"); put("CLICKUP_TEAM_ID"); break;
    // NPM_GITHUB_TOKEN too: repos with private @scope packages read it from their committed .npmrc,
    // and without it `npm install` 401s, so the agent cannot run any of the repo's own checks.
    case "github": put("GH_TOKEN"); put("GH_TOKEN", "NPM_GITHUB_TOKEN"); break;
    case "azure":
      // az login --service-principal -u $AZURE_CLIENT_ID -p $AZURE_CLIENT_SECRET --tenant $AZURE_TENANT_ID (runner does this at start when present)
      put("AZURE_CLIENT_ID"); put("AZURE_TENANT_ID"); put("AZURE_CLIENT_SECRET"); put("AZURE_SUBSCRIPTION_ID");
      break;
    case "azure-user":
      // Runner does `az login --identity` against the broker; tokens carry the logged-in human's rights.
      if (config.AZURE_BROKER_URL && config.AZURE_BROKER_SECRET) {
        out.IDENTITY_ENDPOINT = `${config.AZURE_BROKER_URL}/token`;
        out.IDENTITY_HEADER = config.AZURE_BROKER_SECRET;
        out.MSI_ENDPOINT = out.IDENTITY_ENDPOINT;
        out.MSI_SECRET = out.IDENTITY_HEADER;
        put("AZURE_TENANT_ID");
        put("AZURE_SUBSCRIPTION_ID");
      }
      break;
    case "vertex":
      out.CLAUDE_CODE_USE_VERTEX = "1";
      for (const k of ["ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION"]) {
        const v = process.env[k];
        if (v) out[k] = v;
      }
      break;
    default:
      throw new Error(`unknown credential grant "${grant}"`);
  }
  return out;
}
