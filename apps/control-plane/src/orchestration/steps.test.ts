import { describe, expect, it } from "vitest";
import type { Role } from "@ai-employee/core";
import { loadConfig } from "../config.js";
import { environmentFooter, resolvableMcpServers, resolveImage } from "./steps.js";

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

describe("buildRunSpec credential names", () => {
  it("resolvableMcpServers keeps clickup when a grant provides its env names", () => {
    const servers = { clickup: { command: "c", env: { K: "${CLICKUP_API_TOKEN}" } } };
    const names = { CLICKUP_API_TOKEN: "1" };
    expect(Object.keys(resolvableMcpServers(servers, names))).toEqual(["clickup"]);
    expect(Object.keys(resolvableMcpServers(servers, {}))).toEqual([]);
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

  it("every role is told about employee_status / list_tasks / message_owner; only `operate` roles about the operator tools", () => {
    const role = { id: "r", description: "", systemPrompt: "", allowedTools: [], disallowedTools: [], mcpServers: {}, maxTurns: 1, runtime: "k8s", cpu: 1, memoryMb: 1, timeoutSec: 1, credentials: [], repos: [], capabilities: [], canSpawn: [], canSchedule: [] } as unknown as Role;
    const plain = environmentFooter(role);
    for (const t of ["employee_status", "list_tasks", "message_owner"]) expect(plain).toContain(t);
    for (const t of ["start_task", "cancel_task", "task_events", "claude_settings"]) expect(plain).not.toContain(t);
    const op = environmentFooter({ ...role, capabilities: ["operate"] });
    for (const t of ["start_task", "cancel_task", "task_events", "claude_settings"]) expect(op).toContain(t);
  });
});

describe("resolveImage", () => {
  const cfg = (images = "") => loadConfig({ DATABASE_URL: "x", DBOS_SYSTEM_DATABASE_URL: "x", RUNNER_IMAGE: "base:1", RUNNER_IMAGES: images } as NodeJS.ProcessEnv);
  const role = (r: Partial<Role>) => r as Role;
  it("imageRef > image > RUNNER_IMAGE", () => {
    const c = cfg('{"runner-ops":"ops:2"}');
    expect(resolveImage(role({ imageRef: "runner-ops", image: "legacy:0" }), c)).toEqual({ image: "ops:2", jobName: "ai-employee-runner-ops" });
    expect(resolveImage(role({ image: "legacy:0" }), c)).toEqual({ image: "legacy:0" });
    expect(resolveImage(role({}), c)).toEqual({ image: "base:1" });
  });
  it("an imageRef without a RUNNER_IMAGES entry falls back to RUNNER_IMAGE but keeps the job name", () => {
    expect(resolveImage(role({ imageRef: "x" }), cfg())).toEqual({ image: "base:1", jobName: "ai-employee-x" });
  });
  it("rejects a malformed RUNNER_IMAGES", () => {
    expect(() => cfg("[1]")).toThrow(/RUNNER_IMAGES/);
  });
});
