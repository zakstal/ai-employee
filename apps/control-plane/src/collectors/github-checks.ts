import { z } from "zod";
import { ghGet } from "../github-api.js";
import type { Finding } from "../monitors/types.js";
import { githubToken, repoName } from "./github.js";
import type { Collector } from "./types.js";

const schema = z.object({
  repos: z.array(z.string().regex(repoName, "repo must be owner/name")).min(1),
  branches: z.array(z.string().min(1)).default(["main"]),
});

interface CheckRuns {
  check_runs: { name: string; conclusion: string | null; head_sha: string; html_url?: string }[];
}
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

/** A finding when the latest commit of a watched branch has failing check runs, once per commit. Pending runs are ignored. */
export const githubChecks: Collector<z.infer<typeof schema>> = {
  id: "github-checks",
  configSchema: schema,
  async collect(ctx, config, prev) {
    const token = await githubToken(ctx);
    const first = prev.initialized !== true;
    const before = (prev.branches ?? {}) as Record<string, { sha: string; failing: boolean }>;
    const branches: Record<string, { sha: string; failing: boolean }> = {};
    const findings: Finding[] = [];
    for (const repo of config.repos) {
      for (const branch of config.branches) {
        const runs = ((await (await ghGet(ctx.fetch, token, `/repos/${repo}/commits/${encodeURIComponent(branch)}/check-runs?per_page=100`)).json()) as CheckRuns).check_runs;
        const sha = runs[0]?.head_sha;
        if (!sha) continue;
        const failed = runs.filter((r) => r.conclusion && FAILED.has(r.conclusion));
        const k = `${repo}@${branch}`;
        branches[k] = { sha, failing: failed.length > 0 };
        const was = before[k];
        if (!first && failed.length && !(was?.sha === sha && was.failing)) {
          findings.push({
            key: `checks|${repo}|${branch}|${sha}`,
            text: `${repo} ${branch} is failing checks at ${sha.slice(0, 7)}: ${failed.map((r) => r.name).join(", ")}`,
            evidence: { source: `GitHub ${repo}`, observed: `${failed.length} failing check run(s) on ${sha}`, url: failed[0]?.html_url ?? `https://github.com/${repo}/commit/${sha}` },
          });
        }
      }
    }
    return { findings, state: { initialized: true, branches } };
  },
};
