import { describe, expect, it } from "vitest";
import { EmployeeSchema } from "@ai-employee/core";
import { checkCredentials, listCredentials, setSecret, type Exec } from "./credentials.js";

const emp = EmployeeSchema.parse({
  id: "dev", name: "Dev", defaultRole: "r", roles: [{ id: "r" }],
  credentials: {
    pm: { kind: "secret", env: { TOKEN: { secret: "pm-token" }, TEAM: { value: "1" }, OTHER: { secret: "pm-other" } } },
    one: { kind: "secret", env: { K: { secret: "one-key" } } },
    gh: { kind: "minted", provider: "github-app", appId: "1", installationId: "2", privateKey: { secret: "app-key" }, permissions: { contents: "read" } },
  },
});
const employees = new Map([["dev", emp]]);
const recorder = (code = 0, stderr = "", stdout = "") => {
  const calls: { cmd: string; args: string[]; stdin?: string | undefined }[] = [];
  const exec: Exec = async (cmd, args, stdin) => (calls.push({ cmd, args, stdin }), { code, stdout, stderr });
  return { calls, exec };
};

describe("credentials set", () => {
  it("pipes the value on stdin and never in argv", async () => {
    const r = recorder();
    await setSecret(employees, { employee: "dev", grant: "one", project: "p", value: "VALUE-123" }, r.exec);
    expect(r.calls[0]!.args).toEqual(["secrets", "versions", "add", "one-key", "--project", "p", "--data-file=-"]);
    expect(r.calls[0]!.stdin).toBe("VALUE-123");
    expect(JSON.stringify(r.calls[0]!.args)).not.toContain("VALUE-123");
  });
  it("needs --env when a login has several secrets, and the minted key needs none", async () => {
    await expect(setSecret(employees, { employee: "dev", grant: "pm", project: "p", value: "v" }, recorder().exec)).rejects.toThrow(/pass --env/);
    const r = recorder();
    await setSecret(employees, { employee: "dev", grant: "pm", env: "OTHER", project: "p", value: "v" }, r.exec);
    expect(r.calls[0]!.args[3]).toBe("pm-other");
    const g = recorder();
    await setSecret(employees, { employee: "dev", grant: "gh", project: "p", value: "pem" }, g.exec);
    expect(g.calls[0]!.args[3]).toBe("app-key");
  });
  it("rejects an unknown grant and explains a missing shell", async () => {
    await expect(setSecret(employees, { employee: "dev", grant: "nope", project: "p", value: "v" }, recorder().exec)).rejects.toThrow(/defines no credential "nope"/);
    await expect(setSecret(employees, { employee: "dev", grant: "one", project: "p", value: "v" }, recorder(1, "NOT_FOUND: secret").exec)).rejects.toThrow(/secret shells/);
  });
});

describe("credentials list and check", () => {
  it("list shows kinds, env names and latest version, no values", async () => {
    const r = recorder(0, "", JSON.stringify([{ name: "projects/1/secrets/one-key/versions/7", createTime: "2026-01-01T00:00:00Z" }]));
    const out = (await listCredentials(employees, "dev", "p", r.exec)).join("\n");
    expect(out).toContain("one: secret, env K");
    expect(out).toContain("secret one-key: version 7");
  });
  it("check prints names, not values", async () => {
    const out = (await checkCredentials(employees, "dev", "one", { get: async () => "SUPER-SECRET" })).join("\n");
    expect(out).toBe("one: secret, env K");
    expect(out).not.toContain("SUPER-SECRET");
  });
});
