import { mkdtemp, writeFile } from "node:fs/promises";
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
});
