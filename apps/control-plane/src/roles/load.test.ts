import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEmployees } from "./load.js";

describe("loadEmployees", () => {
  it("loads valid yaml and applies defaults", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roles-"));
    await writeFile(path.join(dir, "dev.yaml"), `id: dev\nname: Dev Bot\ndefaultRole: coder\nroles:\n  - id: coder\n    allowedTools: [Read]\n`);
    const m = await loadEmployees(dir);
    const dev = m.get("dev")!;
    expect(dev.roles[0]!.maxTurns).toBe(50);
    expect(dev.roles[0]!.runtime).toBe("k8s");
  });
  it("fails loudly on invalid config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roles-"));
    await writeFile(path.join(dir, "bad.yaml"), `id: bad\nname: Bad\ndefaultRole: x\nroles: []\n`);
    await expect(loadEmployees(dir)).rejects.toThrow(/invalid employee config bad.yaml/);
  });
  const emp = (id: string, prompt?: string) =>
    `id: ${id}\nname: ${id}\ndefaultRole: r\nroles:\n  - id: r\n${prompt ? `    systemPromptFile: ${prompt}\n` : ""}`;
  const tmp = () => mkdtemp(path.join(tmpdir(), "roles-"));
  it("resolves a prompt from the second dir when the first lacks it", async () => {
    const [a, b] = [await tmp(), await tmp()];
    await writeFile(path.join(a, "dev.yaml"), emp("dev", "prompts/x.md"));
    await mkdir(path.join(b, "prompts"));
    await writeFile(path.join(b, "prompts", "x.md"), "from b");
    expect((await loadEmployees([a, b])).get("dev")!.roles[0]!.systemPrompt).toBe("from b");
  });
  it("the first dir shadows a same-named employee file in the second", async () => {
    const [a, b] = [await tmp(), await tmp()];
    await writeFile(path.join(a, "dev.yaml"), emp("first"));
    await writeFile(path.join(b, "dev.yaml"), emp("second"));
    await writeFile(path.join(b, "other.yaml"), emp("other"));
    expect([...(await loadEmployees([a, b])).keys()].sort()).toEqual(["first", "other"]);
  });
  it("reads employees/ when the dir has one", async () => {
    const a = await tmp();
    await mkdir(path.join(a, "employees"));
    await writeFile(path.join(a, "employees", "dev.yaml"), emp("dev"));
    await writeFile(path.join(a, "stray.yaml"), "not: an employee");
    expect([...(await loadEmployees(a)).keys()]).toEqual(["dev"]);
  });
  it("rejects a prompt path that escapes via a sibling-prefix directory", async () => {
    const parent = await tmp();
    const roles = path.join(parent, "roles");
    await mkdir(roles);
    await mkdir(path.join(parent, "roles-evil"));
    await writeFile(path.join(parent, "roles-evil", "x.md"), "evil");
    await writeFile(path.join(roles, "dev.yaml"), emp("dev", "../roles-evil/x.md"));
    await expect(loadEmployees(roles)).rejects.toThrow(/escapes/);
  });
});
