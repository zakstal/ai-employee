import { GoogleAuth } from "google-auth-library";

export interface ExecutionRef {
  projectId: string;
  jobName: string;
  executionName: string;
}

/** Reads the tail of one Cloud Run Job execution's logs. An interface so tests (and other log backends) can stand in. */
export interface ExecutionLogReader {
  /** Last `tail` lines, oldest first. */
  tail(ref: ExecutionRef, tail: number): Promise<string[]>;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const ENDPOINT = "https://logging.googleapis.com/v2/entries:list";

interface LogEntry {
  timestamp?: string;
  textPayload?: string;
  jsonPayload?: { message?: unknown } & Record<string, unknown>;
}

/**
 * Cloud Logging `entries:list` over REST, authenticated with the control plane's own application-default
 * credentials (needs roles/logging.viewer on the project). No logging SDK: one POST.
 */
export class CloudLoggingReader implements ExecutionLogReader {
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { getToken?: () => Promise<string>; fetchImpl?: typeof fetch } = {}) {
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/logging.read"] });
    this.getToken =
      opts.getToken ??
      (async () => {
        const t = await auth.getAccessToken();
        if (!t) throw new Error("no application-default credentials for Cloud Logging");
        return t;
      });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async tail(ref: ExecutionRef, tail: number): Promise<string[]> {
    // The names go into a filter expression: refuse anything that is not a plain resource name.
    for (const v of [ref.projectId, ref.jobName, ref.executionName]) if (!NAME.test(v)) throw new Error(`refusing to query logs for odd resource name "${v}"`);
    const filter = `resource.type="cloud_run_job" AND resource.labels.job_name="${ref.jobName}" AND labels."run.googleapis.com/execution_name"="${ref.executionName}"`;
    const res = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.getToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ resourceNames: [`projects/${ref.projectId}`], filter, orderBy: "timestamp desc", pageSize: tail }),
    });
    if (!res.ok) throw new Error(`Cloud Logging: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const { entries = [] } = (await res.json()) as { entries?: LogEntry[] };
    return entries
      .reverse()
      .map((e) => {
        const text = e.textPayload ?? (typeof e.jsonPayload?.message === "string" ? e.jsonPayload.message : JSON.stringify(e.jsonPayload ?? ""));
        return `${e.timestamp ?? ""} ${text}`.trim();
      });
  }
}
