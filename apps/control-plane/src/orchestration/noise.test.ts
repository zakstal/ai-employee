import { describe, expect, it } from "vitest";
import { isNoiseVerdict, resolveCredentials, summarize } from "./steps.js";

describe("isNoiseVerdict", () => {
  it("accepts the bare word, a trailing verdict after reasoning, and markdown-wrapped forms", () => {
    expect(isNoiseVerdict("NOISE")).toBe(true);
    expect(isNoiseVerdict("noise.")).toBe(true);
    expect(isNoiseVerdict("Queues clear, no backlog. Same scanner sweep as before.\n\nNOISE\n")).toBe(true);
    expect(isNoiseVerdict("checked queues\n**NOISE**")).toBe(true);
  });
  it("also suppresses the manager's IDLE heartbeat verdict", () => {
    expect(isNoiseVerdict("IDLE")).toBe(true);
    expect(isNoiseVerdict("Checked branches and running tasks, nothing stuck.\n\nIDLE")).toBe(true);
    expect(isNoiseVerdict("**IDLE**")).toBe(true);
    expect(isNoiseVerdict("Two tickets are IDLE but ENG-42 needs dispatching")).toBe(false);
  });

  it("rejects real alerts that merely mention noise", () => {
    expect(isNoiseVerdict("P3 watch — OperationNotFound new peak; not scanner noise this time.\n!dev investigate x")).toBe(false);
    expect(isNoiseVerdict("NOISE floor is exceeded: P2 degraded on sender")).toBe(false);
  });
});

describe("summarize", () => {
  it("names the cause instead of 'ended without a result' for the two ways a run dies", () => {
    expect(summarize({ code: 1 }, undefined)).toContain("turn limit");
    expect(summarize({ code: 137, reason: "timeout" }, undefined)).toContain("time limit");
    expect(summarize({ code: 7 }, undefined)).toContain("exit 7");
    expect(summarize({ code: 0 }, { runId: "r", seq: 1, ts: "t", type: "result", text: "all good", isError: false })).toBe("all good");
  });
});

describe("github grant", () => {
  it("also sets NPM_GITHUB_TOKEN, which private @scope .npmrc files read", () => {
    const env = resolveCredentials(["github"], { GH_TOKEN: "ghp_x" } as never);
    expect(env.GH_TOKEN).toBe("ghp_x");
    expect(env.NPM_GITHUB_TOKEN).toBe("ghp_x");
    expect(resolveCredentials(["clickup"], { GH_TOKEN: "ghp_x" } as never).NPM_GITHUB_TOKEN).toBeUndefined();
  });
});
