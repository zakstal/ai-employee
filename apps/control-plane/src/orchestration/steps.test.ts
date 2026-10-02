import { describe, expect, it } from "vitest";
import type { Role } from "@ai-employee/core";
import { environmentFooter, resolvableMcpServers } from "./steps.js";

describe("resolvableMcpServers", () => {
  const servers = {
    clickup: { command: "clickup-mcp", env: { CLICKUP_API_KEY: "${CLICKUP_API_TOKEN}", CLICKUP_TEAM_ID: "${CLICKUP_TEAM_ID}" } },
    plain: { command: "echo" },
    withDefault: { command: "x", env: { A: "${OPTIONAL:-fallback}" } },
  };
  it("keeps servers whose placeholders resolve, drops the rest", () => {
    expect(Object.keys(resolvableMcpServers(servers, {}))).toEqual(["plain"]);
    expect(Object.keys(resolvableMcpServers(servers, { CLICKUP_API_TOKEN: "pk", CLICKUP_TEAM_ID: "1", OPTIONAL: "y" }))).toEqual(["clickup", "plain", "withDefault"]);
  });
});

describe("environmentFooter", () => {
  it("states az/gh/clickup/delegation from grants and allowlist", () => {
    const f = environmentFooter({
      id: "r", description: "", systemPrompt: "", allowedTools: ["Read", "Bash(az *)", "Bash(gh *)"], disallowedTools: [], mcpServers: {}, maxTurns: 1,
      runtime: "k8s", cpu: 1, memoryMb: 1, timeoutSec: 1, credentials: ["azure-user", "github", "clickup"], repos: [{ url: "https://github.com/o/r.git" }],
      capabilities: ["agents", "schedules"], canSpawn: [], canSchedule: [],
    } as Role);
    expect(f).toContain("ALREADY LOGGED IN");
    expect(f).toContain("gh pr create");
    expect(f).toContain("mcp__clickup__*");
    expect(f).toContain("/workspace: r");
    expect(f).toContain("spawn_agent");
    expect(f).toContain("az *, gh *");
  });
});
