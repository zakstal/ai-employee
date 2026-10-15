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
  it("logs into azure with the federated token when AZURE_FEDERATED_CLIENT_ID is set", () => {
    const run = vi.fn().mockReturnValueOnce({ status: 0, stdout: "google.id.token\n", stderr: "" }).mockReturnValue({ status: 0, stderr: "" });
    const notes = bootstrapTools({ AZURE_FEDERATED_CLIENT_ID: "cid", AZURE_TENANT_ID: "t", AZURE_SUBSCRIPTION_ID: "sub" }, run as never);
    expect(notes).toEqual(["az: logged in via federated credential"]);
    expect(run.mock.calls[0]![0]).toBe("curl");
    expect(run.mock.calls[0]![1]).toContain("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=api%3A%2F%2FAzureADTokenExchange&format=full");
    expect(run.mock.calls[1]![1]).toEqual(["login", "--service-principal", "-u", "cid", "--tenant", "t", "--federated-token", "google.id.token", "--allow-no-subscriptions", "--output", "none"]);
    expect(run.mock.calls[2]![1]).toEqual(["account", "set", "--subscription", "sub"]);
  });
  it("federated login reports failure without throwing, and is skipped when AZURE_CLIENT_SECRET is set", () => {
    const noToken = vi.fn().mockReturnValue({ status: 22, stdout: "", stderr: "not on gcp" });
    expect(bootstrapTools({ AZURE_FEDERATED_CLIENT_ID: "c", AZURE_TENANT_ID: "t" }, noToken as never)[0]).toMatch(/federated token unavailable: not on gcp/);
    const badLogin = vi.fn().mockReturnValueOnce({ status: 0, stdout: "tok", stderr: "" }).mockReturnValue({ status: 1, stderr: "AADSTS70021" });
    expect(bootstrapTools({ AZURE_FEDERATED_CLIENT_ID: "c", AZURE_TENANT_ID: "t" }, badLogin as never)[0]).toMatch(/federated login failed: AADSTS70021/);
    const skipped = vi.fn().mockReturnValue({ status: 0, stderr: "" });
    expect(bootstrapTools({ AZURE_FEDERATED_CLIENT_ID: "c", AZURE_TENANT_ID: "t", AZURE_CLIENT_SECRET: "s", AZURE_CLIENT_ID: "x" }, skipped as never)).toEqual(["az: logged in as service principal"]);
    expect(skipped.mock.calls.some((c) => c[0] === "curl")).toBe(false);
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
