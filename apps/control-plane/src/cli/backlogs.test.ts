import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { simulateBacklog } from "./backlogs.js";

describe("simulateBacklog", () => {
  it("prints ready items from the file without a database", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "sim-"));
    await writeFile(path.join(d, "e.yaml"), "id: e\nname: E\ndefaultRole: r\nroles: [{ id: r }]\nbacklogs:\n  b: { source: { kind: repo-file, repo: o/r, ref: z, path: L.md }, dispatch: { role: r, brief: x }, order: phase }\n");
    const fetchImpl = (async () => new Response("## Phase 1\n- [ ] Button\n## Phase 2\n- [ ] Input\n")) as unknown as typeof fetch;
    const out = await simulateBacklog([d], "e", "b", "tok", fetchImpl);
    expect(out).toContain("ready (in order):\n  - button (phase 1, branch ai/b/button)\n  - input");
    await expect(simulateBacklog([d], "e", "nope", "tok", fetchImpl)).rejects.toThrow(/no backlog nope/);
  });
});
