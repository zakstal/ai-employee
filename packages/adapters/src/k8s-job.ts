import { createHash } from "node:crypto";
import {
  ApiException,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  type V1Job,
} from "@kubernetes/client-node";
import type { RunExit, RunHandle, RunSpec, SandboxRuntime } from "@ai-employee/core";

const LABEL = "app.kubernetes.io/name";
const RUN_ID_LABEL = "ai-employee/run-id";
const RUN_ID_ANNOTATION = "ai-employee/run-id";

/** DNS-1123 label: lowercase alnum + '-', 63 chars max, must start/end alnum. */
function dns1123(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "x";
}

function truncateWithSuffix(name: string, original: string): string {
  if (name.length <= 63 && name === original) return name;
  const suffix = "-" + createHash("sha256").update(original).digest("hex").slice(0, 8);
  const base = name.slice(0, 63 - suffix.length).replace(/-+$/g, "");
  return base + suffix;
}

function jobNameFor(runId: string): string {
  const sanitized = dns1123(runId);
  return truncateWithSuffix(sanitized, runId);
}

/** externalId is always `${namespace}/${jobName}`, set by this class in `start`. */
function parseHandle(handle: RunHandle): { namespace: string; jobName: string } {
  const i = handle.externalId.indexOf("/");
  if (i < 0) throw new Error(`KubernetesJobRuntime: malformed externalId ${handle.externalId}`);
  return { namespace: handle.externalId.slice(0, i), jobName: handle.externalId.slice(i + 1) };
}

export interface KubernetesJobRuntimeOptions {
  kubeConfig?: KubeConfig;
  namespaceFor?: (employeeId: string) => string;
  ttlSecondsAfterFinished?: number;
  pollIntervalMs?: number;
  serviceAccountName?: string;
  runAsNonRoot?: boolean;
}

/**
 * Runs the runner as a Kubernetes Job. Recovers from the cluster on restart
 * (no in-memory run table besides the cancelled-run set — see `wait`).
 */
export class KubernetesJobRuntime implements SandboxRuntime {
  readonly name = "k8s";

  private readonly batch: BatchV1Api;
  private readonly core: CoreV1Api;
  private readonly namespaceFor: (employeeId: string) => string;
  private readonly ttlSecondsAfterFinished: number;
  private readonly pollIntervalMs: number;
  private readonly serviceAccountName: string | undefined;
  private readonly runAsNonRoot: boolean;
  private readonly cancelled = new Set<string>();

  constructor(options: KubernetesJobRuntimeOptions = {}) {
    const kc = options.kubeConfig ?? new KubeConfig();
    if (!options.kubeConfig) kc.loadFromDefault();
    this.batch = kc.makeApiClient(BatchV1Api);
    this.core = kc.makeApiClient(CoreV1Api);
    this.namespaceFor = options.namespaceFor ?? ((employeeId) => dns1123(`ai-emp-${employeeId}`));
    this.ttlSecondsAfterFinished = options.ttlSecondsAfterFinished ?? 600;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.serviceAccountName = options.serviceAccountName;
    this.runAsNonRoot = options.runAsNonRoot ?? true;
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    const namespace = this.namespaceFor(spec.employeeId);
    const jobName = jobNameFor(spec.runId);

    try {
      await this.core.createNamespace({ body: { metadata: { name: namespace } } });
    } catch (err) {
      if (!(err instanceof ApiException) || err.code !== 409) throw err;
    }

    const body: V1Job = {
      metadata: {
        name: jobName,
        labels: { [LABEL]: "ai-employee-runner", [RUN_ID_LABEL]: dns1123(spec.runId) },
        annotations: { [RUN_ID_ANNOTATION]: spec.runId },
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: this.ttlSecondsAfterFinished,
        activeDeadlineSeconds: spec.timeoutSec,
        template: {
          metadata: {
            labels: { [LABEL]: "ai-employee-runner", [RUN_ID_LABEL]: dns1123(spec.runId) },
          },
          spec: {
            restartPolicy: "Never",
            automountServiceAccountToken: false,
            ...(this.serviceAccountName ? { serviceAccountName: this.serviceAccountName } : {}),
            ...(this.runAsNonRoot ? { securityContext: { runAsNonRoot: true } } : {}),
            containers: [
              {
                name: "runner",
                image: spec.image,
                ...(spec.command ? { command: spec.command } : {}),
                env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
                resources: {
                  requests: { cpu: String(spec.cpu), memory: `${spec.memoryMb}Mi` },
                  limits: { cpu: String(spec.cpu), memory: `${spec.memoryMb}Mi` },
                },
              },
            ],
          },
        },
      },
    };

    try {
      await this.batch.createNamespacedJob({ namespace, body });
    } catch (err) {
      if (!(err instanceof ApiException) || err.code !== 409) throw err;
    }

    return { adapter: this.name, externalId: `${namespace}/${jobName}` };
  }

  async wait(handle: RunHandle, opts?: { signal?: AbortSignal }): Promise<RunExit> {
    const { namespace, jobName } = parseHandle(handle);
    const signal = opts?.signal;

    for (;;) {
      if (signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }

      let job: V1Job;
      try {
        job = await this.batch.readNamespacedJobStatus({ name: jobName, namespace });
      } catch (err) {
        if (err instanceof ApiException && err.code === 404) {
          return this.cancelled.has(handle.externalId)
            ? { code: 137, reason: "cancelled" }
            : { code: 1, reason: "lost" };
        }
        throw err;
      }

      const status = job.status;
      if (status?.succeeded && status.succeeded >= 1) return { code: 0 };

      const failed = status?.conditions?.find((c) => c.type === "Failed" && c.status === "True");
      if (failed) {
        if (failed.reason === "DeadlineExceeded") return { code: 137, reason: "timeout" };
        return { code: await this.podExitCode(namespace, jobName), reason: failed.reason ?? "failed" };
      }

      await this.sleep(this.pollIntervalMs, signal);
    }
  }

  private async podExitCode(namespace: string, jobName: string): Promise<number> {
    try {
      const pods = await this.core.listNamespacedPod({
        namespace,
        labelSelector: `job-name=${jobName}`,
      });
      const exitCode = pods.items[0]?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode;
      return exitCode ?? 1;
    } catch {
      return 1;
    }
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

  async cancel(handle: RunHandle): Promise<void> {
    const { namespace, jobName } = parseHandle(handle);
    this.cancelled.add(handle.externalId);
    try {
      await this.batch.deleteNamespacedJob({ name: jobName, namespace, propagationPolicy: "Background" });
    } catch (err) {
      if (!(err instanceof ApiException) || err.code !== 404) throw err;
    }
  }
}
