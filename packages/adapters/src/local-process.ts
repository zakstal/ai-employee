import { spawn, type ChildProcess } from "node:child_process";
import type { RunExit, RunHandle, RunSpec, SandboxRuntime } from "@ai-employee/core";

/**
 * Runs the "container" as a local child process. Used for tests and laptop dev.
 * `command` receives the RunSpec so tests can substitute `sh -c 'echo ...'`
 * and dev can point at `node apps/runner/dist/index.js`.
 *
 * ponytail: in-memory process table, so `wait` after a control-plane restart
 * returns code 1/"lost". Real adapters (k8s) recover from the cluster instead.
 */
export class LocalProcessRuntime implements SandboxRuntime {
  readonly name = "local";
  private procs = new Map<string, { child: ChildProcess; exit: Promise<RunExit> }>();

  constructor(private command: (spec: RunSpec) => string[]) {}

  async start(spec: RunSpec): Promise<RunHandle> {
    const existing = this.procs.get(spec.runId);
    if (existing) return { adapter: this.name, externalId: spec.runId };

    const [cmd, ...args] = this.command(spec);
    if (!cmd) throw new Error("LocalProcessRuntime: empty command");
    const child = spawn(cmd, args, {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...spec.env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, spec.timeoutSec * 1000);
    const exit = new Promise<RunExit>((resolve) => {
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: 127, reason: err.message });
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) resolve({ code: 137, reason: "timeout" });
        else if (signal) resolve({ code: 137, reason: signal === "SIGTERM" ? "cancelled" : signal });
        else resolve({ code: code ?? 1 });
      });
    });
    this.procs.set(spec.runId, { child, exit });
    return { adapter: this.name, externalId: spec.runId };
  }

  async wait(handle: RunHandle): Promise<RunExit> {
    const p = this.procs.get(handle.externalId);
    if (!p) return { code: 1, reason: "lost" };
    const exit = await p.exit;
    this.procs.delete(handle.externalId);
    return exit;
  }

  async cancel(handle: RunHandle): Promise<void> {
    this.procs.get(handle.externalId)?.child.kill("SIGTERM");
  }
}
