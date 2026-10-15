import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkConfig } from "../cli/check.js";
import { loadEmployees } from "./load.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const presets = path.join(root, "presets");
const examples = path.join(root, "examples");

describe("shipped presets", () => {
  it("the example employee loads on the sdlc bundle with every prompt resolving", async () => {
    const dev = (await loadEmployees([examples, presets])).get("dev")!;
    expect(dev.roles.map((r) => r.id).sort()).toEqual(["assistant", "compound", "developer", "implement", "manager", "monitor-triage", "ops", "review", "spec", "triage"]);
    expect(Object.keys(dev.workstreams).sort()).toEqual(["compound", "sdlc"]);
    expect(dev.roles.find((r) => r.id === "implement")!.systemPrompt).toContain("🤖 Created by Dev Bot");
    expect(dev.roles.find((r) => r.id === "triage")!.allowedTools).toEqual(dev.roles.find((r) => r.id === "spec")!.allowedTools);
  });
  it("abstract roles are not employee roles, and vars without a default are never left unfilled", async () => {
    const dev = (await loadEmployees([examples, presets])).get("dev")!;
    expect(dev.roles.some((r) => r.id.startsWith("_"))).toBe(false);
    for (const r of dev.roles) expect(r.systemPrompt).not.toMatch(/\{\{/);
  });
  it("passes config check", async () => {
    expect(await checkConfig({ dirs: [examples, presets], managerRole: "manager" })).toEqual([]);
  });
});
