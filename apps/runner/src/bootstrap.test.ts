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
});
