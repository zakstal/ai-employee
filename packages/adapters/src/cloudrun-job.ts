import { JobsClient, ExecutionsClient, type protos } from "@google-cloud/run";
import type { RunExit, RunHandle, RunSpec, SandboxRuntime } from "@ai-employee/core";

type Execution = protos.google.cloud.run.v2.IExecution;

/**
 * Env var we stamp on every execution's container override so we can find it
 * again. Confirmed against the installed @google-cloud/run v4 .d.ts/protos:
 * RunJobRequest.Overrides only has {containerOverrides, taskCount, timeout} —
 * no labels field — so labels can't be set per-execution at run time (they
 * CAN be read back on Execution.labels, just not written via overrides).
 * Dedup therefore matches on this env var instead of a label.
 */
const TASK_ID_ENV = "AI_EMPLOYEE_RUN_ID";

const GRPC_NOT_FOUND = 5; // google-gax Status.NOT_FOUND

function grpcCode(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? (err as { code?: number }).code
    : undefined;
}

function isTerminal(e: Execution): boolean {
  return (e.succeededCount ?? 0) >= 1 || (e.failedCount ?? 0) >= 1 || (e.cancelledCount ?? 0) >= 1;
}

/**
 * Cloud Run v2 does not expose the container's exit code on the Execution
 * resource (verified: IExecution has succeeded/failed/cancelledCount and
 * conditions[], nothing like containerStatuses[].exitCode). So non-zero
 * failures all come back as code 1 — only the `reason` distinguishes them.
 */
function terminalExit(e: Execution): RunExit {
  const completed = e.conditions?.find((c) => c.type === "Completed");
  const reason = completed?.reason as string | undefined;
  const executionReason = completed?.executionReason as string | undefined;
  const message = completed?.message ?? "";

  if (reason === "PROGRESS_DEADLINE_EXCEEDED" || /deadline|timeout/i.test(message)) {
    return { code: 137, reason: "timeout" };
  }
  if ((e.cancelledCount ?? 0) >= 1 || executionReason === "CANCELLED" || executionReason === "CANCELLING") {
    return { code: 137, reason: "cancelled" };
  }
  return { code: 1, reason: reason ?? executionReason ?? "failed" };
}

export interface CloudRunJobRuntimeOptions {
  projectId: string;
  region: string;
  /**
   * Jobs are pre-created by Terraform, one per runner image. The Job for a run is derived from the
   * image basename: `.../runner:tag` → `${jobPrefix}-runner`, `runner-ops:dev` → `${jobPrefix}-runner-ops`.
   * `jobName` forces a single Job for every run instead (legacy / tests).
   */
  jobPrefix?: string;
  jobName?: string;
  /**
   * Not sent to Cloud Run: v2 RunJobRequest.Overrides has no serviceAccount
   * field, so the Job's service account is fixed at Terraform-deploy time.
   * Accepted here only in case we later use it for ADC impersonation.
   */
  serviceAccountEmail?: string;
  client?: { jobs: JobsClient; executions: ExecutionsClient };
  pollIntervalMs?: number;
}

/**
 * Runs the runner as an Execution of a pre-existing Cloud Run Job. The Job
 * resource itself (image, one per runner image) is provisioned out of band
 * by Terraform; this class only triggers and tracks Executions of it.
 */
export class CloudRunJobRuntime implements SandboxRuntime {
  readonly name = "cloudrun";

  private readonly jobs: JobsClient;
  private readonly executions: ExecutionsClient;
  private readonly pollIntervalMs: number;
  private readonly cancelled = new Set<string>();
  private readonly jobsParent: string;
  private readonly jobPrefix: string;
  private readonly fixedJobName: string | undefined;

  constructor(options: CloudRunJobRuntimeOptions) {
    this.jobs = options.client?.jobs ?? new JobsClient();
    this.executions = options.client?.executions ?? new ExecutionsClient();
    this.jobsParent = `projects/${options.projectId}/locations/${options.region}/jobs`;
    this.jobPrefix = options.jobPrefix ?? "ai-employee";
    this.fixedJobName = options.jobName;
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
  }

  /** `us-central1-docker.pkg.dev/p/r/runner-ops:tag` → `.../jobs/ai-employee-runner-ops`. */
  jobPathFor(image: string): string {
    if (this.fixedJobName) return `${this.jobsParent}/${this.fixedJobName}`;
    const basename = (image.split("/").pop() ?? image).replace(/[@:].*$/, "");
    // Local images are already named `ai-employee-runner[-ops]`; registry images are `runner[-ops]`.
    const jobName = basename.startsWith(`${this.jobPrefix}-`) ? basename : `${this.jobPrefix}-${basename}`;
    return `${this.jobsParent}/${jobName}`;
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    const jobPath = this.jobPathFor(spec.image);
    const existing = await this.findActiveExecution(spec.runId, jobPath);
    if (existing?.name) return { adapter: this.name, externalId: existing.name };

    const env = [
      ...Object.entries(spec.env).map(([name, value]) => ({ name, value })),
      { name: TASK_ID_ENV, value: spec.runId },
    ];

    const [operation] = await this.jobs.runJob({
      name: jobPath,
      overrides: {
        containerOverrides: [{ env, ...(spec.command ? { args: spec.command } : {}) }],
        timeout: { seconds: spec.timeoutSec },
        taskCount: 1,
      },
    });

    // The LRO's metadata is typed (and, per Cloud Run's behavior, populated
    // before completion) as the Execution being created — read the name off
    // it rather than awaiting operation.promise(). Fall back to a fresh list
    // in case a given library version doesn't populate metadata early.
    const executionName =
      (operation.metadata as Execution | null | undefined)?.name ??
      (await this.findActiveExecution(spec.runId, jobPath))?.name;

    if (!executionName) {
      throw new Error(`CloudRunJobRuntime: could not resolve execution name for run ${spec.runId}`);
    }

    return { adapter: this.name, externalId: executionName };
  }

  async wait(handle: RunHandle, opts?: { signal?: AbortSignal }): Promise<RunExit> {
    const signal = opts?.signal;

    for (;;) {
      if (signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }

      let execution: Execution;
      try {
        const [result] = await this.executions.getExecution({ name: handle.externalId });
        execution = result;
      } catch (err) {
        if (grpcCode(err) === GRPC_NOT_FOUND) {
          return this.cancelled.has(handle.externalId)
            ? { code: 137, reason: "cancelled" }
            : { code: 1, reason: "lost" };
        }
        throw err;
      }

      if ((execution.succeededCount ?? 0) >= 1) return { code: 0 };
      if (isTerminal(execution)) return terminalExit(execution);

      await this.sleep(this.pollIntervalMs, signal);
    }
  }

  async cancel(handle: RunHandle): Promise<void> {
    this.cancelled.add(handle.externalId);
    try {
      await this.executions.cancelExecution({ name: handle.externalId });
    } catch (err) {
      if (grpcCode(err) !== GRPC_NOT_FOUND) throw err;
    }
  }

  /** Non-terminal execution whose container env carries this runId — our idempotency key. */
  private async findActiveExecution(runId: string, jobPath: string): Promise<Execution | undefined> {
    const [list] = await this.executions.listExecutions({ parent: jobPath, pageSize: 50 });
    return list.find((e) => {
      const hasRunId = e.template?.containers?.[0]?.env?.some(
        (v) => v.name === TASK_ID_ENV && v.value === runId,
      );
      return hasRunId && !isTerminal(e);
    });
  }


  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        },
        { once: true },
      );
    });
  }
}
