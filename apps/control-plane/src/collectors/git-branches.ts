import { z } from "zod";
import { ghList } from "../github-api.js";
import type { Finding } from "../monitors/types.js";
import { githubToken, repoName } from "./github.js";
import type { Collector } from "./types.js";

const schema = z.object({
  repos: z.array(z.string().regex(repoName, "repo must be owner/name")).min(1),
  /** Glob over branch names: `*` matches anything, including `/`. */
  pattern: z.string().min(1).default("*"),
});

const glob = (p: string): RegExp => new RegExp(`^${p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

/** A finding when a matching branch appears or its head moves. */
export const gitBranches: Collector<z.infer<typeof schema>> = {
  id: "git-branches",
  configSchema: schema,
  async collect(ctx, config, prev) {
    const token = await githubToken(ctx);
    const first = prev.initialized !== true;
    const before = (prev.heads ?? {}) as Record<string, string>;
    const heads: Record<string, string> = {};
    const findings: Finding[] = [];
    const re = glob(config.pattern);
    for (const repo of config.repos) {
      for (const b of await ghList<{ name: string; commit: { sha: string } }>(ctx.fetch, token, `/repos/${repo}/branches`)) {
        if (!re.test(b.name)) continue;
        const k = `${repo}@${b.name}`;
        heads[k] = b.commit.sha;
        if (first || before[k] === b.commit.sha) continue;
        findings.push({
          key: `branch|${k}|${b.commit.sha}`,
          text: `${repo} branch ${b.name} ${before[k] ? "has a new commit" : "appeared"} (${b.commit.sha.slice(0, 7)})`,
          evidence: { source: `GitHub ${repo}`, observed: `head ${b.commit.sha}`, url: `https://github.com/${repo}/tree/${b.name}` },
        });
      }
    }
    return { findings, state: { initialized: true, heads } };
  },
};
