import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bootstrapTools } from "./bootstrap.js";

describe("bootstrapTools", () => {
  it("does nothing without credentials", () => {
    const run = vi.fn();
    expect(bootstrapTools({}, run as never)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
  it("logs into azure with a service principal and sets subscription", () => {
    const run = vi.fn().mockReturnValue({ status: 0, stderr: "" });
    const notes = bootstrapTools({ AZURE_CLIENT_ID: "id", AZURE_TENANT_ID: "t", AZURE_CLIENT_SECRET: "s", AZURE_SUBSCRIPTION_ID: "sub" }, run as never);
    expect(notes).toEqual(["az: logged in as service principal"]);
    expect(run.mock.calls[0]![0]).toBe("az");
    expect(run.mock.calls[0]![1]).toContain("--service-principal");
    expect(run.mock.calls[1]![1]).toEqual(["account", "set", "--subscription", "sub"]);
  });
  it("configures git for GH_TOKEN and clones REPOS", () => {
    const run = vi.fn().mockReturnValue({ status: 0, stderr: "" });
    const notes = bootstrapTools({ GH_TOKEN: "t", REPOS: JSON.stringify([{ url: "https://github.com/o/r.git", ref: "main" }]), WORKSPACE_DIR: "/ws" }, run as never);
    expect(notes).toContain("git: credential helper → gh");
    expect(notes).toContain("repos: cloned https://github.com/o/r.git → r");
    const clone = run.mock.calls.find((c) => (c[1] as string[])[0] === "clone")!;
    expect(clone[1]).toEqual(["clone", "--depth", "50", "--branch", "main", "https://github.com/o/r.git", "/ws/r"]);
  });
  it("logs into azure via the token broker when IDENTITY_ENDPOINT is set", () => {
    const run = vi.fn().mockReturnValue({ status: 0, stderr: "" });
    const notes = bootstrapTools({ IDENTITY_ENDPOINT: "http://azbroker:8081/token", IDENTITY_HEADER: "s", AZURE_SUBSCRIPTION_ID: "sub" }, run as never);
    expect(notes).toContain("az: logged in via token broker");
    expect(run.mock.calls[0]![1]).toEqual(["login", "--identity", "--allow-no-subscriptions", "--output", "none"]);
  });
  it("reports failure without throwing", () => {
    const run = vi.fn().mockReturnValue({ status: 1, stderr: Buffer.from("bad creds") });
    expect(bootstrapTools({ AZURE_CLIENT_ID: "id", AZURE_TENANT_ID: "t", AZURE_CLIENT_SECRET: "s" }, run as never)[0]).toMatch(/az: login failed: bad creds/);
  });
  it("runs executables in bootstrap.d in name order and reports their last stdout line", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bootstrap-d-"));
    writeFileSync(path.join(dir, "20-b.sh"), "");
    writeFileSync(path.join(dir, "10-a.sh"), "");
    writeFileSync(path.join(dir, "README"), ""); // not executable: skipped
    chmodSync(path.join(dir, "20-b.sh"), 0o755);
    chmodSync(path.join(dir, "10-a.sh"), 0o755);
    const run = vi.fn().mockReturnValueOnce({ status: 0, stdout: "noise\nhook a ok\n", stderr: "" }).mockReturnValueOnce({ status: 0, stdout: "hook b ok\n", stderr: "" });
    const notes = bootstrapTools({ BOOTSTRAP_D_DIR: dir }, run as never);
    expect(run.mock.calls.map((c) => c[0])).toEqual([path.join(dir, "10-a.sh"), path.join(dir, "20-b.sh")]);
    expect(notes).toEqual(["hook a ok", "hook b ok"]);
  });
  it("reports a failing bootstrap.d hook instead of throwing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bootstrap-d-"));
    writeFileSync(path.join(dir, "10-bad.sh"), "");
    chmodSync(path.join(dir, "10-bad.sh"), 0o755);
    const run = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "boom" });
    expect(bootstrapTools({ BOOTSTRAP_D_DIR: dir }, run as never)).toEqual(["bootstrap.d/10-bad.sh: failed: boom"]);
  });
  it("skips bootstrap.d when the directory does not exist", () => {
    const run = vi.fn();
    expect(bootstrapTools({ BOOTSTRAP_D_DIR: "/nonexistent/bootstrap.d" }, run as never)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
