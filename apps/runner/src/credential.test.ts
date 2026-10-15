import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCredential, type Deps } from "./credential.js";

function setup(expiresInMin: number | null) {
  let now = Date.parse("2026-01-01T00:00:00Z");
  let n = 0;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    n++;
    return new Response(JSON.stringify({ env: { GH_TOKEN: `tok-${n}` }, expiresAt: expiresInMin === null ? null : new Date(now + expiresInMin * 60_000).toISOString() }));
  }) as unknown as typeof fetch;
  const d: Deps = { env: { CONTROL_PLANE_URL: "http://cp", RUN_TOKEN: "rt", TASK_ID: "t1" }, fetch: f, now: () => now, cacheFile: path.join(mkdtempSync(path.join(tmpdir(), "cred-")), "c.json") };
  return { d, calls, advance: (min: number) => (now += min * 60_000) };
}

describe("getCredential", () => {
  it("authorises with the run token and task id", async () => {
    const s = setup(60);
    await getCredential("github", s.d);
    expect(s.calls[0]).toEqual({ url: "http://cp/credentials/github/refresh", headers: { authorization: "Bearer rt", "x-task-id": "t1" } });
  });
  it("cache is reused until near expiry, then refetched", async () => {
    const s = setup(60);
    expect((await getCredential("github", s.d)).env.GH_TOKEN).toBe("tok-1");
    s.advance(50);
    expect((await getCredential("github", s.d)).env.GH_TOKEN).toBe("tok-1");
    expect(s.calls).toHaveLength(1);
    s.advance(6); // 56 min in: inside the 5 minute skew of the 60 minute expiry
    expect((await getCredential("github", s.d)).env.GH_TOKEN).toBe("tok-2");
  });
  it("a failed refresh throws", async () => {
    const s = setup(60);
    s.d.fetch = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(getCredential("github", s.d)).rejects.toThrow(/credential refresh 403/);
  });
});
