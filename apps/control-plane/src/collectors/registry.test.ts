import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkConfig } from "../cli/check.js";
import { getCollector, loadPlugins, monitorProblems } from "./index.js";

const plugin = (id: string) =>
  `export default { id: "${id}", configSchema: { parse: (v) => { if (typeof v.n !== "number") throw new Error("n must be a number"); return v; }, safeParse: (v) => typeof v.n === "number" ? { success: true, data: v } : { success: false, error: { issues: [{ path: ["n"], message: "must be a number" }] } } }, async collect() { return { findings: [], state: {} }; } };\n`;
async function dirWith(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "plug-"));
  await mkdir(path.join(d, "collectors"));
  for (const [f, body] of Object.entries(files)) await writeFile(path.join(d, "collectors", f), body);
  return d;
}
const emp = (collector: string, config: object = {}) => ({ id: "e", monitors: { m: { collector, everyMin: 5, role: "r", description: "", config } } });

describe("collector registry", () => {
  it("has the built-ins", () => {
    for (const id of ["azure-errors", "clickup-channels", "github-prs", "github-checks", "clickup-task-status", "git-branches"]) expect(getCollector(id)?.id).toBe(id);
  });
  it("an unknown id is a problem that lists the known ones", () => {
    expect(monitorProblems([emp("nope")])[0]).toMatch(/unknown collector "nope" \(known: azure-errors, clickup-channels/);
  });
  it("a plugin from a config dir is loaded and its config schema is used", async () => {
    const d = await dirWith({ "mine.mjs": plugin("plug-a"), "ignored.txt": "x" });
    expect((await loadPlugins([d])).loaded).toEqual(["plug-a"]);
    expect((await loadPlugins([d])).loaded).toEqual(["plug-a"]); // twice is fine
    expect(monitorProblems([emp("plug-a", { n: 1 })])).toEqual([]);
    expect(monitorProblems([emp("plug-a", { n: "x" })])[0]).toMatch(/config for plug-a: n: must be a number/);
  });
  it("an id collision with a built-in is reported and the built-in stays", async () => {
    const d = await dirWith({ "clash.mjs": plugin("github-prs") });
    const r = await loadPlugins([d]);
    expect(r.loaded).toEqual([]);
    expect(r.errors[0]).toMatch(/id "github-prs" is already registered/);
    expect(getCollector("github-prs")?.configSchema.safeParse({ repos: ["o/r"] }).success).toBe(true);
  });
  it("a plugin that throws at import or is not a Collector is reported, not fatal", async () => {
    const d = await dirWith({ "boom.mjs": "throw new Error('kaboom');", "bad.mjs": "export default { id: 'x' };" });
    const r = await loadPlugins([d]);
    expect(r.loaded).toEqual([]);
    expect(r.errors.map((e) => e.replace(/^.*collectors\//, ""))).toEqual(["bad.mjs: default export is not a Collector {id, configSchema, collect}", "boom.mjs: kaboom"]);
  });
  it("bad config of a built-in fails validation; existing azure configs stay valid", () => {
    expect(monitorProblems([emp("github-prs", { repos: ["not-a-repo"] })])[0]).toMatch(/repos.0: repo must be owner\/name/);
    expect(monitorProblems([emp("azure-errors", { apps: [{ rg: "r", name: "n" }], lookbackMin: 15, extra: true })])).toEqual([]);
  });
  it("config check reports unknown collectors and broken plugins; passes with a good plugin", async () => {
    const good = await dirWith({ "ok.mjs": plugin("plug-check") });
    await writeFile(path.join(good, "e.yaml"), "id: e\nname: E\ndefaultRole: r\nroles: [{ id: r }]\nmonitors:\n  m: { collector: plug-check, role: r, config: { n: 1 } }\n");
    expect(await checkConfig({ dirs: [good] })).toEqual([]);
    const bad = await dirWith({ "boom.mjs": "throw new Error('kaboom');" });
    await writeFile(path.join(bad, "e.yaml"), "id: e\nname: E\ndefaultRole: r\nroles: [{ id: r }]\nmonitors:\n  m: { collector: ghost, role: r }\n");
    const problems = await checkConfig({ dirs: [bad] });
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/kaboom[\s\S]*unknown collector "ghost"/);
  });
});
