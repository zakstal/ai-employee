import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadEmployees } from "./load.js";
import { mergeRole, resolveRoles, substitute } from "./merge.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures");
const role = (id: string, rest: Record<string, unknown> = {}) => ({ id, ...rest });
const one = (own: object[], base: object[] = [], id?: string) => {
  const rs = resolveRoles(own as never, base as never);
  return rs.find((r) => r.id === (id ?? (own.at(-1) as { id: string }).id))!;
};

describe("mergeRole", () => {
  it("+key appends, dedupes and keeps order", () => {
    expect(mergeRole({ allowedTools: ["a", "b"] }, { "+allowedTools": ["b", "c"] }).allowedTools).toEqual(["a", "b", "c"]);
  });
  it("-key removes entries (repos match on url)", () => {
    expect(mergeRole({ allowedTools: ["a", "b"] }, { "-allowedTools": ["a"] }).allowedTools).toEqual(["b"]);
    expect(mergeRole({ repos: [{ url: "u1", ref: "x" }, { url: "u2" }] }, { "-repos": [{ url: "u1" }] }).repos).toEqual([{ url: "u2" }]);
  });
  it("a plain list key replaces", () => {
    expect(mergeRole({ allowedTools: ["a"] }, { allowedTools: ["z"] }).allowedTools).toEqual(["z"]);
  });
  it("mcpServers merge by name and -mcpServers removes a server", () => {
    const p = { mcpServers: { a: { command: "x" }, b: { command: "y" } } };
    expect(mergeRole(p, { mcpServers: { b: { command: "z" } } }).mcpServers).toEqual({ a: { command: "x" }, b: { command: "z" } });
    expect(mergeRole(p, { "-mcpServers": ["a"] }).mcpServers).toEqual({ b: { command: "y" } });
  });
  it("a child systemPromptFile replaces inherited prompt files", () => {
    expect(mergeRole({ systemPromptFiles: ["a.md", "b.md"] }, { systemPromptFile: "c.md" })).toMatchObject({ systemPromptFile: "c.md" });
    expect(mergeRole({ systemPromptFiles: ["a.md", "b.md"] }, { systemPromptFile: "c.md" }).systemPromptFiles).toBeUndefined();
  });
  it("+systemPromptFiles on a legacy parent keeps its file first", () => {
    expect(mergeRole({ systemPromptFile: "a.md" }, { "+systemPromptFiles": ["b.md"] }).systemPromptFiles).toEqual(["a.md", "b.md"]);
  });
});

describe("resolveRoles", () => {
  it("extends copies parent fields", () => {
    expect(one([role("p", { model: "m", allowedTools: ["a"] }), role("c", { extends: "p" })])).toMatchObject({ model: "m", allowedTools: ["a"] });
  });
  it("the same id as a bundle role patches it", () => {
    expect(one([role("d", { "+allowedTools": ["b"] })], [role("d", { allowedTools: ["a"], maxTurns: 7 })])).toMatchObject({ allowedTools: ["a", "b"], maxTurns: 7 });
  });
  it("a bundle-only role is included", () => {
    expect(resolveRoles([role("x")] as never, [role("b")] as never).map((r) => r.id)).toEqual(["b", "x"]);
  });
  it("an abstract _role is not emitted", () => {
    expect(resolveRoles([role("_p"), role("c", { extends: "_p" })] as never, []).map((r) => r.id)).toEqual(["c"]);
  });
  it("a cycle in extends throws", () => {
    expect(() => resolveRoles([role("a", { extends: "b" }), role("b", { extends: "a" })] as never, [])).toThrow(/cycle/);
  });
  it("an unknown parent throws", () => {
    expect(() => resolveRoles([role("a", { extends: "nope" })] as never, [])).toThrow(/unknown role nope/);
  });
});

describe("substitute", () => {
  it("fills vars and defaults, throws on an unknown var", () => {
    expect(substitute("{{A}} {{B:-d}}", { A: "1" }, "r")).toBe("1 d");
    expect(() => substitute("{{FOO}}", {}, "r")).toThrow(/no var FOO/);
  });
});

describe("loadEmployees with extends, use, include, vars", () => {
  it("extends fixture equals the flat fixture", async () => {
    const [a, b] = await Promise.all([fixtureDir("dev-extends.yaml"), fixtureDir("dev-flat.yaml")]);
    expect(await loadEmployees(a)).toEqual(await loadEmployees(b));
  });
  it("joins prompt files in order and fills BOT_NAME / PR_SIGNATURE / defaults", async () => {
    const dev = (await loadEmployees(await fixtureDir("dev-extends.yaml"))).get("dev")!;
    expect(dev.roles.find((r) => r.id === "developer")!.systemPrompt).toBe("You are Dev Bot.\n\n\nSign with 🤖 Created by Dev Bot. Team: core.\n");
  });
  it("employee vars override built-ins", async () => {
    const dir = await fixtureDir("dev-extends.yaml");
    await writeFile(path.join(dir, "dev.yaml"), (await import("node:fs")).readFileSync(path.join(dir, "dev.yaml"), "utf8") + "vars: { PR_SIGNATURE: signed, TEAM: web }\n");
    expect((await loadEmployees(dir)).get("dev")!.roles[0]!.systemPrompt).toContain("Sign with signed. Team: web.");
  });
  it("include merges roles and workstreams, a duplicate id throws", async () => {
    const dir = await fixtureDir("dev-flat.yaml");
    await writeFile(path.join(dir, "frag.yaml.inc"), "roles:\n  - id: extra\nworkstreams:\n  w: { entryRole: extra }\n");
    const f = path.join(dir, "dev.yaml");
    const base = (await import("node:fs")).readFileSync(f, "utf8");
    await writeFile(f, `include: [frag.yaml.inc]\n${base}`);
    const dev = (await loadEmployees(dir)).get("dev")!;
    expect(dev.roles.map((r) => r.id)).toContain("extra");
    expect(Object.keys(dev.workstreams).sort()).toEqual(["sdlc", "w"]);
    await writeFile(path.join(dir, "frag.yaml.inc"), "roles:\n  - id: developer\n");
    await expect(loadEmployees(dir)).rejects.toThrow(/duplicate role developer/);
  });
  it("use loads bundles/ from the second dir", async () => {
    const inst = await mkdtemp(path.join(tmpdir(), "inst-"));
    await writeFile(path.join(inst, "dev.yaml"), "id: dev\nname: D\ndefaultRole: developer\nuse: [sdlc]\nroles: []\n");
    const presets = await mkdtemp(path.join(tmpdir(), "presets-"));
    await cp(path.join(fixtures, "bundles"), path.join(presets, "bundles"), { recursive: true });
    await cp(path.join(fixtures, "prompts"), path.join(presets, "prompts"), { recursive: true });
    const dev = (await loadEmployees([inst, presets])).get("dev")!;
    expect(dev.roles.map((r) => r.id)).toEqual(["developer"]);
    expect(dev.workstreams.sdlc).toBeDefined();
  });
});

/** A temp dir holding the shared fixtures plus one employee file as dev.yaml. */
async function fixtureDir(employee: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "fx-"));
  await cp(path.join(fixtures, "bundles"), path.join(dir, "bundles"), { recursive: true });
  await cp(path.join(fixtures, "prompts"), path.join(dir, "prompts"), { recursive: true });
  await cp(path.join(fixtures, employee), path.join(dir, "dev.yaml"));
  return dir;
}
