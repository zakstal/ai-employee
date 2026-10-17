/**
 * SandboxRuntime — the ONLY boundary between the control plane and wherever
 * agent containers run (Kubernetes Jobs, Namespace Labs, Cloud Run Jobs, a
 * local process in tests).
 *
 * Deliberately thin: "launch this OCI image with this env, tell me when it
 * exits". The runner pushes its events to the control plane; `status` and `logs`
 * are optional read-only probes for operators (an adapter that cannot answer
 * leaves them out). No volumes, no ports. Credentials arrive as short-lived
 * tokens in `env`.
 */
export interface RunSpec {
  /** Task/workflow ID. Adapters MUST use it as an idempotency key. */
  runId: string;
  /** Runner image; identical across adapters. */
  image: string;
  /** Env for the runner: task prompt, event-sink URL + token, provider creds. */
  env: Record<string, string>;
  cpu: number; // vCPU
  memoryMb: number;
  timeoutSec: number;
  /** Employee id; adapters may map it to a namespace / tenant. */
  employeeId: string;
  /** Cloud Run Job to run; overrides the job name derived from the image. */
  jobName?: string;
  /** Override the image entrypoint. Tests only; production runs the image's own entrypoint. */
  command?: string[];
}

export interface RunHandle {
  adapter: string;
  externalId: string;
}

export interface RunExit {
  code: number;
  reason?: string; // "timeout" | "cancelled" | "oom" | adapter-specific
}

/** Point-in-time view of a run's sandbox, as the platform reports it. */
export interface RunStatus {
  /** `lost`: the platform has no record of the run (reaped, or the host restarted). */
  state: "running" | "ended" | "lost";
  startedAt?: string; // ISO
  endedAt?: string; // ISO
  /** Adapters that cannot read the container's real exit code report 0 / 1 (see the adapter). */
  exitCode?: number;
  reason?: string;
}

export interface SandboxRuntime {
  readonly name: string;
  start(spec: RunSpec): Promise<RunHandle>;
  /** Resolves when the run reaches a terminal state. Must tolerate being called again after a crash. */
  wait(handle: RunHandle, opts?: { signal?: AbortSignal }): Promise<RunExit>;
  cancel(handle: RunHandle): Promise<void>;
  /** One non-blocking look at the sandbox. Optional. */
  status?(handle: RunHandle): Promise<RunStatus>;
  /** The last `tail` log lines, oldest first. Optional; throws if the platform's logs cannot be read. */
  logs?(handle: RunHandle, opts: { tail: number }): Promise<string[]>;
}
