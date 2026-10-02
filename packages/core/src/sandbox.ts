/**
 * SandboxRuntime — the ONLY boundary between the control plane and wherever
 * agent containers run (Kubernetes Jobs, Namespace Labs, Cloud Run Jobs, a
 * local process in tests).
 *
 * Deliberately thin: "launch this OCI image with this env, tell me when it
 * exits". No log tailing (the runner pushes events to the control plane), no
 * volumes, no ports. Credentials arrive as short-lived tokens in `env`.
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

export interface SandboxRuntime {
  readonly name: string;
  start(spec: RunSpec): Promise<RunHandle>;
  /** Resolves when the run reaches a terminal state. Must tolerate being called again after a crash. */
  wait(handle: RunHandle, opts?: { signal?: AbortSignal }): Promise<RunExit>;
  cancel(handle: RunHandle): Promise<void>;
}
