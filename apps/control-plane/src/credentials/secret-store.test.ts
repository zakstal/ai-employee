import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvSecretStore, GcpSecretStore } from "./secret-store.js";

function fakeFetch(secretStatus = 200) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    if (url.includes("metadata.google.internal")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    return new Response(secretStatus === 200 ? JSON.stringify({ payload: { data: Buffer.from("s3cret").toString("base64") } }) : "", { status: secretStatus });
  }) as unknown as typeof fetch;
  return { f, calls };
}

afterEach(() => vi.useRealTimers());

describe("GcpSecretStore", () => {
  it("reads a secret via the metadata token then the REST API", async () => {
    const { f, calls } = fakeFetch();
    expect(await new GcpSecretStore("proj", f).get("a-b")).toBe("s3cret");
    expect(calls[1]).toBe("https://secretmanager.googleapis.com/v1/projects/proj/secrets/a-b/versions/latest:access");
  });
  it("404 is undefined, 403 throws with the hint", async () => {
    expect(await new GcpSecretStore("p", fakeFetch(404).f).get("x")).toBeUndefined();
    await expect(new GcpSecretStore("p", fakeFetch(403).f).get("x")).rejects.toThrow(/secretAccessor/);
  });
  it("caches for 60s", async () => {
    vi.useFakeTimers();
    const { f, calls } = fakeFetch();
    const s = new GcpSecretStore("p", f);
    await s.get("x");
    await s.get("x");
    expect(calls.filter((u) => u.includes("secretmanager"))).toHaveLength(1);
    vi.advanceTimersByTime(61_000);
    await s.get("x");
    expect(calls.filter((u) => u.includes("secretmanager"))).toHaveLength(2);
  });
});

describe("EnvSecretStore", () => {
  it("maps dashes to underscores under SECRET_", async () => {
    process.env.SECRET_MY_KEY = "v";
    expect(await new EnvSecretStore().get("my-key")).toBe("v");
    expect(await new EnvSecretStore().get("nope")).toBeUndefined();
    delete process.env.SECRET_MY_KEY;
  });
});
