import { describe, expect, it } from "vitest";
import { collectAzureErrors } from "./azure.js";
import { collectClickUpChannels } from "./clickup.js";
import { NoopClickUpClient } from "../clickup/client.js";

const auth = { subscriptionId: "sub", brokerUrl: "http://broker", brokerSecret: "s" };
const now = new Date("2026-09-17T12:00:00Z");

/** Fake Azure: broker token, component lookup, KQL results keyed by query text, alerts list. */
function fakeAzure(opts: { exceptions: unknown[][]; failed?: unknown[][]; alerts?: Array<{ id: string; name: string }> }) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (u.startsWith("http://broker/token")) return json({ access_token: "tok" });
    if (u.includes("/providers/Microsoft.Insights/components/")) return json({ properties: { AppId: "app-guid" } });
    if (u.includes("/providers/Microsoft.AlertsManagement/alerts")) {
      return json({ value: (opts.alerts ?? []).map((a) => ({ ...a, properties: { essentials: { severity: "Sev2", targetResourceName: "mcs-insights-prod", startDateTime: "t", monitorCondition: "Fired" } } })) });
    }
    if (u.includes("/v1/apps/app-guid/query")) {
      const q = JSON.parse(String(init?.body)).query as string;
      if (q.startsWith("exceptions")) return json({ tables: [{ columns: ["cloud_RoleName", "type", "n", "sample"].map((name) => ({ name })), rows: opts.exceptions }] });
      return json({ tables: [{ columns: ["cloud_RoleName", "resultCode", "n", "name"].map((name) => ({ name })), rows: opts.failed ?? [] }] });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("azure-errors collector", () => {
  const config = { apps: [{ rg: "rg", name: "prod-insights" }], lookbackMin: 15, minCount: 5 };

  it("first run only records the baseline (no findings), later runs flag NEW signatures, SPIKEs and new alerts", async () => {
    const a1 = fakeAzure({ exceptions: [["api", "OperationNotFound", 1000, "no op"], ["worker", "TimeoutError", 4, "slow"]], alerts: [{ id: "/a/1", name: "Old alert" }] });
    const r1 = await collectAzureErrors(config, auth, {}, now, a1.fetchImpl);
    expect(r1.findings).toEqual([]);
    expect(r1.state.initialized).toBe(true);
    expect((r1.state.appIds as Record<string, string>)["prod-insights"]).toBe("app-guid");

    // same volume of OperationNotFound (no spike), TimeoutError 4→40 (spike), a brand-new type, a new alert
    const a2 = fakeAzure({
      exceptions: [["api", "OperationNotFound", 1100, "no op"], ["worker", "TimeoutError", 40, "slow"], ["sender", "SmsSenderError", 3, "boom"]],
      failed: [["api", "500", 12, "POST /send"]],
      alerts: [{ id: "/a/1", name: "Old alert" }, { id: "/a/2", name: "Message API failed requests" }],
    });
    const r2 = await collectAzureErrors(config, auth, r1.state, new Date(now.getTime() + 300_000), a2.fetchImpl);
    const texts = r2.findings.map((f) => f.text);
    expect(texts.some((t) => t.startsWith("SPIKE") && t.includes("TimeoutError") && t.includes("40 in last 15m (24h peak was 4)"))).toBe(true);
    expect(texts.some((t) => t.startsWith("NEW") && t.includes("SmsSenderError"))).toBe(true);
    expect(texts.some((t) => t.startsWith("NEW") && t.includes("HTTP 500 on POST /send"))).toBe(true);
    expect(texts.some((t) => t.startsWith("ALERT Sev2 \"Message API failed requests\""))).toBe(true);
    expect(texts.some((t) => t.includes("OperationNotFound"))).toBe(false);
    expect(texts.some((t) => t.includes("Old alert"))).toBe(false);
    // component lookup is cached in state: not fetched again
    expect(a2.calls.filter((u) => u.includes("/components/"))).toHaveLength(0);
  });

  it("oscillating noise does not re-fire: SPIKE compares against the 24h peak; alert rules have a cooldown; one-offs are ignored", async () => {
    const ex = (n: number, extra: unknown[][] = []) => fakeAzure({ exceptions: [["api", "OperationNotFound", n, "no op"], ...extra], alerts: [{ id: "/a/1", name: "Sender high volume" }] }).fetchImpl;
    let state = (await collectAzureErrors(config, auth, {}, now, ex(21))).state;
    const step = async (mins: number, n: number, extra: unknown[][] = []) => {
      const r = await collectAzureErrors(config, auth, state, new Date(now.getTime() + mins * 60_000), ex(n, extra));
      state = r.state;
      return r.findings.map((f) => f.text);
    };
    expect(await step(5, 108)).toEqual([expect.stringContaining("SPIKE")]); // 108 >= 3 * peak 21 → real spike, once
    expect(await step(10, 497)).toEqual([expect.stringContaining("SPIKE")]); // 497 >= 3 * 108
    expect(await step(15, 791)).toEqual([]); // < 3 * 497
    expect(await step(20, 300)).toEqual([]); // back down: no finding
    expect(await step(25, 900)).toEqual([]); // 900 < 3 * peak 791
    // alert /a/1 re-fires with a NEW id but the same rule+target → in cooldown, not reported
    const again = fakeAzure({ exceptions: [["api", "OperationNotFound", 300, "no op"]], alerts: [{ id: "/a/99", name: "Sender high volume" }] }).fetchImpl;
    const r = await collectAzureErrors(config, auth, state, new Date(now.getTime() + 30 * 60_000), again);
    expect(r.findings).toEqual([]);
    // a one-off new signature (n=1) is ignored; n=3 is reported
    expect(await step(35, 300, [["worker", "Blip", 1, "x"]])).toEqual([]);
    expect(await step(40, 300, [["worker", "Blip", 3, "x"]])).toEqual([expect.stringContaining("NEW [prod] exception Blip")]);
  });

  it("does not spend anything when nothing changed", async () => {
    const rows: unknown[][] = [["api", "OperationNotFound", 1000, "no op"]];
    const r1 = await collectAzureErrors(config, auth, {}, now, fakeAzure({ exceptions: rows }).fetchImpl);
    const r2 = await collectAzureErrors(config, auth, r1.state, now, fakeAzure({ exceptions: rows }).fetchImpl);
    expect(r2.findings).toEqual([]);
  });
});

describe("clickup-channels collector", () => {
  it("first run sets cursors silently; later runs report only new human messages", async () => {
    const clickup = new NoopClickUpClient();
    clickup.history.set("c1", [
      { id: "102", text: "\u{1F916} bot reply", userId: "9" },
      { id: "101", text: "customer says sends are failing", userId: "7" },
    ]);
    const config = { channels: [{ id: "c1", name: "us-support" }] };
    const r1 = await collectClickUpChannels(config, clickup, "ws", {});
    expect(r1.findings).toEqual([]);
    expect((r1.state.lastId as Record<string, string>).c1).toBe("102");

    clickup.history.set("c1", [
      { id: "104", text: "\u{1F916} another bot line", userId: "9" },
      { id: "103", text: "still failing for Acme, 500s on send", userId: "7" },
      { id: "102", text: "\u{1F916} bot reply", userId: "9" },
    ]);
    const r2 = await collectClickUpChannels(config, clickup, "ws", r1.state);
    expect(r2.findings.map((f) => f.text)).toEqual(["#us-support user 7: still failing for Acme, 500s on send"]);
    expect((r2.state.lastId as Record<string, string>).c1).toBe("104");
  });
});

describe("collectSafely", () => {
  /** Minimal DueMonitor whose collector always throws, to exercise the consecutive-failure rule. */
  const broken = (state: Record<string, unknown>) =>
    ({ employee: { id: "dev" }, name: "azure-errors", monitor: { collector: "azure-errors", everyMin: 5, role: "r", description: "", config: { apps: [{ rg: "rg", name: "prod-insights" }] } }, row: { state } }) as never;

  it("stays silent on the first failure, reports on the second in a row, and resets after a good run", async () => {
    const { collectSafely } = await import("./tick.js");
    const { setWorkflowDeps } = await import("../orchestration/deps.js");
    const failing = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    setWorkflowDeps({ config: { AZURE_SUBSCRIPTION_ID: "sub", AZURE_BROKER_URL: "", AZURE_BROKER_SECRET: "", AZURE_TENANT_ID: "", AZURE_CLIENT_ID: "", AZURE_CLIENT_SECRET: "", CLICKUP_TEAM_ID: "ws", ALERT_CHANNEL_ID: "" } } as never);
    void failing;

    const r1 = await collectSafely(broken({}), now);
    expect(r1.findings).toEqual([]);
    expect(r1.state.collectorFailures).toBe(1);

    const r2 = await collectSafely(broken(r1.state), now);
    expect(r2.findings).toHaveLength(1);
    expect(r2.findings[0]!.text).toContain("failed 2 runs in a row");
    expect(r2.state.collectorFailures).toBe(2);
  });
});

describe("evidence", () => {
  it("every azure finding carries a re-runnable source, window, counts and link", async () => {
    const cfg = { apps: [{ rg: "test-rg", name: "prod-insights" }], lookbackMin: 15, minCount: 5, minNew: 1 };
    const first = await collectAzureErrors(cfg, auth, {}, now, fakeAzure({ exceptions: [] }).fetchImpl);
    const r = await collectAzureErrors(
      cfg,
      auth,
      first.state,
      now,
      fakeAzure({ exceptions: [["renderer", "FunctionTimeoutException", 56, "Timeout value of 00:10:00 was exceeded"]] }).fetchImpl,
    );
    const e = r.findings[0]!.evidence!;
    expect(e.source).toBe("Application Insights (test-rg/prod-insights)");
    expect(e.window).toContain("last 15m as of");
    expect(e.observed).toContain("56");
    expect(e.url).toContain("/resourceGroups/test-rg/providers/Microsoft.Insights/components/prod-insights/logs");
    expect(e.query).toContain('type == "FunctionTimeoutException"');
    expect(e.query).toContain('cloud_RoleName == "renderer"');
  });

  it("renders into the monitor brief, which tells the agent to carry it verbatim", async () => {
    const { renderEvidence } = await import("./types.js");
    const block = renderEvidence({ source: "s", window: "w", observed: "o", url: "u", query: "line1\nline2" });
    expect(block).toContain("  source: s");
    expect(block).toContain("  link: u");
    expect(block).toContain("    line1");
  });
});

describe("monitor credentials", () => {
  it("uses the federated assertion when the monitor names a federated credential", async () => {
    const { getAzureToken } = await import("./azure.js");
    const calls: { url: string; body?: string }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init?.body ? { body: String(init.body) } : {}) });
      if (String(url).includes("metadata.google.internal")) return new Response("google.id.token\n");
      return new Response(JSON.stringify({ access_token: "azure-tok" }));
    }) as unknown as typeof fetch;
    const tok = await getAzureToken({ subscriptionId: "s", federated: { tenantId: "t1", clientId: "c1", audience: "api://AzureADTokenExchange" } }, "https://management.azure.com", f);
    expect(tok).toBe("azure-tok");
    expect(calls[1]!.url).toBe("https://login.microsoftonline.com/t1/oauth2/v2.0/token");
    const body = new URLSearchParams(calls[1]!.body);
    expect(body.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    expect(body.get("client_assertion")).toBe("google.id.token");
    expect(body.get("scope")).toBe("https://management.azure.com/.default");
  });
  it("azureAuthFor reads the broker key from the secret store, and falls back to global env without a credential", async () => {
    const { azureAuthFor } = await import("./tick.js");
    const employee = { id: "e", credentials: { b: { kind: "broker", provider: "azure", url: "http://azbroker:8081", secret: { secret: "k" }, subscriptionId: "emp-sub" } } } as never;
    const config = { AZURE_SUBSCRIPTION_ID: "global", AZURE_BROKER_URL: "http://g", AZURE_BROKER_SECRET: "gs", AZURE_TENANT_ID: "", AZURE_CLIENT_ID: "", AZURE_CLIENT_SECRET: "" } as never;
    const secrets = { get: async (n: string) => (n === "k" ? "key-1" : undefined) };
    expect(await azureAuthFor(employee, { credential: "b" } as never, config, secrets)).toEqual({ subscriptionId: "emp-sub", brokerUrl: "http://azbroker:8081", brokerSecret: "key-1" });
    expect(await azureAuthFor(employee, {} as never, config, secrets)).toMatchObject({ subscriptionId: "global", brokerSecret: "gs" });
    await expect(azureAuthFor(employee, { credential: "nope" } as never, config, secrets)).rejects.toThrow(/must name a broker or federated/);
  });
});
