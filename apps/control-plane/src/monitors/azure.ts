import type { CollectResult, Evidence, Fetch, Finding } from "./types.js";

/**
 * Azure error collector. Deterministic, no model: App Insights KQL (exceptions + 5xx by role/type) per
 * configured app, plus new Azure Monitor alerts. Fires only on a NEW signature or a spike (>= 3x the last
 * run and >= `minCount`). The first run only records the baseline.
 *
 * Auth: the token broker (App Service MI protocol) — the same login the runner uses — or, when
 * AZURE_CLIENT_SECRET is set, a service-principal client-credentials grant.
 */
export interface AzureApp {
  rg: string;
  name: string;
}
export interface AzureErrorsConfig {
  apps?: AzureApp[];
  lookbackMin?: number;
  /** SPIKE needs at least this many in the window (default 5) ... */
  minCount?: number;
  /** ... and NEW signatures at least this many (default 3): one-offs are not worth a triage run. */
  minNew?: number;
  /** SPIKE = at least this multiple of the signature's 24h peak (default 3). */
  spikeFactor?: number;
  alerts?: boolean;
  /** The same alert rule on the same target is reported at most once per this many minutes (default 360). */
  alertCooldownMin?: number;
}
/** Logs blade for the component, so a human can paste the query straight in. */
function portalLogsUrl(subscriptionId: string, app: AzureApp): string {
  return `https://portal.azure.com/#resource/subscriptions/${subscriptionId}/resourceGroups/${app.rg}/providers/Microsoft.Insights/components/${app.name}/logs`;
}

export interface AzureAuth {
  subscriptionId: string;
  brokerUrl?: string | undefined;
  brokerSecret?: string | undefined;
  tenantId?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  /** Federated login: the control plane's own Google identity is exchanged for an Azure token. No secret. */
  federated?: { tenantId: string; clientId: string; audience: string } | undefined;
}
interface Seen {
  n: number;
  at: string;
  /** Highest count seen in the trailing 24h: the SPIKE baseline. Comparing against the previous run alone
   *  re-fires every cycle on oscillating noise (observed: 21→108→497→791→3016 on one bot-scanner signature). */
  peak: number;
  peakAt: string;
}
interface AzureState {
  initialized?: boolean;
  appIds?: Record<string, string>;
  seen?: Record<string, Seen>;
  /** alert rule|target → last time we reported it */
  alertRules?: Record<string, string>;
}

const MGMT = "https://management.azure.com";
const APPINSIGHTS = "https://api.applicationinsights.io";
const SEEN_TTL_MS = 24 * 3600 * 1000;

export async function getAzureToken(auth: AzureAuth, resource: string, fetchImpl: Fetch = fetch): Promise<string> {
  if (auth.clientSecret && auth.clientId && auth.tenantId) {
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: auth.clientId, client_secret: auth.clientSecret, scope: `${resource.replace(/\/?$/, "/")}.default` });
    const res = await fetchImpl(`https://login.microsoftonline.com/${auth.tenantId}/oauth2/v2.0/token`, { method: "POST", body });
    if (!res.ok) throw new Error(`azure token (sp) ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }
  if (auth.federated) {
    const { tenantId, clientId, audience } = auth.federated;
    const idRes = await fetchImpl(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`, { headers: { "Metadata-Flavor": "Google" } });
    if (!idRes.ok) throw new Error(`google id token ${idRes.status}`);
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      scope: `${resource.replace(/\/?$/, "/")}.default`,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: (await idRes.text()).trim(),
    });
    const res = await fetchImpl(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, { method: "POST", body });
    if (!res.ok) throw new Error(`azure token (federated) ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }
  if (!auth.brokerUrl || !auth.brokerSecret) throw new Error("no Azure credentials: set AZURE_BROKER_URL/SECRET or AZURE_CLIENT_*");
  const res = await fetchImpl(`${auth.brokerUrl}/token?resource=${encodeURIComponent(resource)}`, { headers: { "X-IDENTITY-HEADER": auth.brokerSecret } });
  if (!res.ok) throw new Error(`azure token (broker) ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function getJson<T>(fetchImpl: Fetch, url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetchImpl(url, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url.split("?")[0]} → ${res.status}`);
  return (await res.json()) as T;
}

type Table = { tables: Array<{ columns: Array<{ name: string }>; rows: unknown[][] }> };
function rowsOf(t: Table): Record<string, unknown>[] {
  const table = t.tables[0];
  if (!table) return [];
  return table.rows.map((r) => Object.fromEntries(table.columns.map((c, i) => [c.name, r[i]])));
}

export async function collectAzureErrors(
  config: AzureErrorsConfig,
  auth: AzureAuth,
  prevState: Record<string, unknown>,
  now: Date,
  fetchImpl: Fetch = fetch,
): Promise<CollectResult> {
  const prev = prevState as AzureState;
  const lookback = config.lookbackMin ?? 15;
  const minCount = config.minCount ?? 5;
  const minNew = config.minNew ?? 3;
  const spikeFactor = config.spikeFactor ?? 3;
  const seen: Record<string, Seen> = {};
  for (const [k, v] of Object.entries(prev.seen ?? {})) if (now.getTime() - Date.parse(v.at) < SEEN_TTL_MS) seen[k] = v;
  const appIds: Record<string, string> = { ...(prev.appIds ?? {}) };
  const findings: Finding[] = [];
  const observed: Record<string, { n: number; text: string; evidence: Evidence }> = {};

  if ((config.apps ?? []).length) {
    const mgmtToken = await getAzureToken(auth, MGMT, fetchImpl);
    const aiToken = await getAzureToken(auth, APPINSIGHTS, fetchImpl);
    for (const app of config.apps ?? []) {
      const label = app.name.replace(/-insights$/, "");
      if (!appIds[app.name]) {
        const c = await getJson<{ properties: { AppId: string } }>(
          fetchImpl,
          `${MGMT}/subscriptions/${auth.subscriptionId}/resourceGroups/${app.rg}/providers/Microsoft.Insights/components/${app.name}?api-version=2020-02-02`,
          mgmtToken,
        );
        appIds[app.name] = c.properties.AppId;
      }
      const query = async (kql: string) =>
        rowsOf(await getJson<Table>(fetchImpl, `${APPINSIGHTS}/v1/apps/${appIds[app.name]}/query`, aiToken, { method: "POST", body: JSON.stringify({ query: kql }) }));
      const source = `Application Insights (${app.rg}/${app.name})`;
      const url = portalLogsUrl(auth.subscriptionId, app);
      const window = `last ${lookback}m as of ${now.toISOString()}`;
      const excKql = `exceptions | where timestamp > ago(${lookback}m) | summarize n=count(), sample=any(outerMessage) by cloud_RoleName, type | top 25 by n`;
      const exceptions = await query(excKql);
      for (const r of exceptions) {
        const key = `${label}|exc|${r.cloud_RoleName}|${r.type}`;
        const role = String(r.cloud_RoleName || "?");
        observed[key] = {
          n: Number(r.n),
          text: `[${label}] exception ${String(r.type)} in ${role}: ${String(r.sample ?? "").slice(0, 160)}`,
          evidence: {
            source,
            window,
            url,
            query: `exceptions\n| where timestamp > ago(${lookback}m) and type == "${String(r.type)}"${role === "?" ? "" : ` and cloud_RoleName == "${role}"`}\n| summarize count() by bin(timestamp, 5m)`,
          },
        };
      }
      const failed = await query(
        `requests | where timestamp > ago(${lookback}m) and success == false and toint(resultCode) >= 500 | summarize n=count() by cloud_RoleName, resultCode, name | top 25 by n`,
      );
      for (const r of failed) {
        const key = `${label}|5xx|${r.cloud_RoleName}|${r.resultCode}|${r.name}`;
        observed[key] = {
          n: Number(r.n),
          text: `[${label}] HTTP ${String(r.resultCode)} on ${String(r.name)} in ${String(r.cloud_RoleName || "?")}`,
          evidence: {
            source,
            window,
            url,
            query: `requests\n| where timestamp > ago(${lookback}m) and name == "${String(r.name)}" and resultCode == "${String(r.resultCode)}"\n| summarize count() by bin(timestamp, 5m)`,
          },
        };
      }
    }
  }

  for (const [key, o] of Object.entries(observed)) {
    const before = seen[key];
    const peakFresh = before && now.getTime() - Date.parse(before.peakAt ?? before.at) < SEEN_TTL_MS;
    const peak = before ? (peakFresh ? Math.max(before.peak ?? before.n, before.n) : before.n) : 0;
    // Below the NEW threshold and never seen: don't record it yet, so it still reads as NEW once it crosses.
    if (!before && o.n < minNew) continue;
    if (prev.initialized) {
      if (!before) {
        findings.push({ key, text: `NEW ${o.text} — ${o.n} in last ${lookback}m`, evidence: { ...o.evidence, observed: `${o.n} in the window; first time this signature has been seen` } });
      } else if (o.n >= minCount && o.n >= Math.max(peak, 1) * spikeFactor) {
        findings.push({ key, text: `SPIKE ${o.text} — ${o.n} in last ${lookback}m (24h peak was ${peak})`, evidence: { ...o.evidence, observed: `${o.n} in the window; previous 24h peak was ${peak}` } });
      }
    }
    const newPeak = o.n >= peak ? { peak: o.n, peakAt: now.toISOString() } : { peak, peakAt: before!.peakAt ?? before!.at };
    seen[key] = { n: o.n, at: now.toISOString(), ...newPeak };
  }

  const alertRules: Record<string, string> = {};
  for (const [k, v] of Object.entries(prev.alertRules ?? {})) if (now.getTime() - Date.parse(v) < SEEN_TTL_MS) alertRules[k] = v;
  if (config.alerts !== false) {
    const cooldownMs = (config.alertCooldownMin ?? 360) * 60_000;
    const token = await getAzureToken(auth, MGMT, fetchImpl);
    const res = await getJson<{ value: Array<{ id: string; name: string; properties: { essentials: { severity: string; targetResourceName: string; startDateTime: string; monitorCondition: string } } }> }>(
      fetchImpl,
      `${MGMT}/subscriptions/${auth.subscriptionId}/providers/Microsoft.AlertsManagement/alerts?api-version=2019-05-05-preview&timeRange=1h&alertState=New`,
      token,
    );
    for (const a of res.value) {
      const e = a.properties.essentials;
      const rule = `${a.name}|${e.targetResourceName}`;
      const last = alertRules[rule];
      const inCooldown = last !== undefined && now.getTime() - Date.parse(last) < cooldownMs;
      if (prev.initialized && !inCooldown) {
        findings.push({
          key: `alert|${rule}`,
          text: `ALERT ${e.severity} "${a.name}" on ${e.targetResourceName} (${e.monitorCondition}, ${e.startDateTime})`,
          evidence: {
            source: `Azure Monitor alert rule "${a.name}"`,
            window: `fired ${e.startDateTime}`,
            observed: `${e.severity}, condition ${e.monitorCondition}, target ${e.targetResourceName}`,
            url: `https://portal.azure.com/#view/Microsoft_Azure_Monitoring/AlertDetails.ReactView/alertId/${encodeURIComponent(a.id)}`,
          },
        });
      }
      if (!inCooldown) alertRules[rule] = now.toISOString();
    }
  }

  return { findings, state: { initialized: true, appIds, seen, alertRules } satisfies AzureState as Record<string, unknown> };
}
