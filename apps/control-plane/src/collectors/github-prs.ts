import { z } from "zod";
import { ghList } from "../github-api.js";
import type { Finding } from "../monitors/types.js";
import { githubToken, repoName } from "./github.js";
import type { Collector } from "./types.js";

const schema = z.object({
  repos: z.array(z.string().regex(repoName, "repo must be owner/name")).min(1),
  /** Only PRs by these logins. */
  authors: z.array(z.string()).optional(),
  /** Only PRs carrying at least one of these labels. */
  labels: z.array(z.string()).optional(),
  events: z.array(z.enum(["opened", "ready", "review-requested"])).min(1).default(["opened", "ready"]),
});

interface Pr {
  number: number;
  title: string;
  html_url: string;
  draft?: boolean;
  user?: { login: string };
  labels?: { name: string }[];
  requested_reviewers?: { login: string }[];
}
type Snap = { draft: boolean; reviewers: string[] };

/**
 * Open PRs of the configured repos. A finding per event, once: `opened` (a PR appears), `ready` (a draft is marked ready),
 * `review-requested` (a new reviewer is requested). ponytail: reads the first 1000 open PRs per repo; fine for a team repo.
 */
export const githubPrs: Collector<z.infer<typeof schema>> = {
  id: "github-prs",
  configSchema: schema,
  async collect(ctx, config, prev) {
    const token = await githubToken(ctx);
    const first = prev.initialized !== true;
    const before = (prev.prs ?? {}) as Record<string, Snap>;
    const prs: Record<string, Snap> = {};
    const findings: Finding[] = [];
    for (const repo of config.repos) {
      for (const pr of await ghList<Pr>(ctx.fetch, token, `/repos/${repo}/pulls?state=open&sort=created&direction=desc`)) {
        if (config.authors && !config.authors.includes(pr.user?.login ?? "")) continue;
        if (config.labels && !pr.labels?.some((l) => config.labels!.includes(l.name))) continue;
        const key = `${repo}#${pr.number}`;
        const cur: Snap = { draft: pr.draft === true, reviewers: (pr.requested_reviewers ?? []).map((r) => r.login).sort() };
        prs[key] = cur;
        const was = before[key];
        const say = (event: string, text: string, observed: string) =>
          findings.push({ key: `pr|${key}|${event}`, text: `${repo}#${pr.number} ${text}: ${pr.title}`, evidence: { source: `GitHub ${repo}`, observed, url: pr.html_url } });
        if (first) continue;
        if (!was) {
          if (config.events.includes("opened")) say("opened", `opened by ${pr.user?.login ?? "?"}`, `PR ${pr.number}${cur.draft ? " (draft)" : ""}`);
        } else {
          if (was.draft && !cur.draft && config.events.includes("ready")) say("ready", "ready for review", "draft -> ready");
          const fresh = cur.reviewers.filter((r) => !was.reviewers.includes(r));
          if (fresh.length && config.events.includes("review-requested")) say(`review-requested|${fresh.join(",")}`, `review requested from ${fresh.join(", ")}`, `reviewers: ${cur.reviewers.join(", ")}`);
        }
      }
    }
    return { findings, state: { initialized: true, prs } };
  },
};
