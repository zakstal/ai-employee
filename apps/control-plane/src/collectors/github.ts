import type { CollectContext } from "./types.js";

/** The monitor's own credential (default grant `github`) as a GitHub token. */
export async function githubToken(ctx: CollectContext): Promise<string | undefined> {
  const env = await ctx.credential(ctx.monitor.credential ?? "github");
  return env.GH_TOKEN ?? env.GITHUB_TOKEN;
}

export const repoName = /^[\w.-]+\/[\w.-]+$/;
