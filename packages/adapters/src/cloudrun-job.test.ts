import { describe, expect, it, vi } from "vitest";
import type { RunSpec } from "@ai-employee/core";
import { CloudRunJobRuntime } from "./cloudrun-job.js";

const JOB_PATH = "projects/p1/locations/us-central1/jobs/ai-employee-runner";
const EXEC = (name: string) => `${JOB_PATH}/executions/${name}`;

const spec = (runId: string, overrides: Partial<RunSpec> = {}): RunSpec => ({
  runId,
  image: "runner:latest",
  env: { FOO: "bar" },
  cpu: 1,
  memoryMb: 512,
  timeoutSec: 60,
  employeeId: "e1",
  ...overrides,
});

function fakeExecution(name: string, runId: string, counts: Partial<Record<"succeededCount" | "failedCount" | "cancelledCount", number>> = {}, conditions: unknown[] = []) {
  return {
    name,
    template: { containers: [{ env: [{ name: "AI_EMPLOYEE_RUN_ID", value: runId }] }] },
    succeededCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    conditions,
    ...counts,
  };
}

function mockClient() {
  const jobs = {
    getJob: vi.fn().mockResolvedValue([{ template: { template: { containers: [{ image: "runner:latest" }] } } }]),
    runJob: vi.fn(),
  };
  const executions = {
    listExecutions: vi.fn().mockResolvedValue([[]]),
    getExecution: vi.fn(),
    cancelExecution: vi.fn().mockResolvedValue([{}]),
  };
  return { jobs, executions } as any;
}

function runtime(client: any) {
  return new CloudRunJobRuntime({ projectId: "p1", region: "us-central1", client });
}

describe("CloudRunJobRuntime", () => {
  it("start() runs the job and returns the execution name from LRO metadata", async () => {
    const client = mockClient();
    client.jobs.runJob.mockResolvedValue([{ metadata: fakeExecution(EXEC("e1"), "r1") }]);

    const rt = runtime(client);
    const handle = await rt.start(spec("r1"));

    expect(handle).toEqual({ adapter: "cloudrun", externalId: EXEC("e1") });
    expect(client.jobs.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        name: JOB_PATH,
        overrides: expect.objectContaining({
          containerOverrides: [
            expect.objectContaining({
              env: expect.arrayContaining([
                { name: "FOO", value: "bar" },
                { name: "AI_EMPLOYEE_RUN_ID", value: "r1" },
              ]),
            }),
          ],
          timeout: { seconds: 60 },
          taskCount: 1,
        }),
      }),
    );
  });

  it("dedups: an active execution with the same runId is reused instead of starting another", async () => {
    const client = mockClient();
    const active = fakeExecution(EXEC("existing"), "r2");
    client.executions.listExecutions.mockResolvedValue([[active]]);

    const rt = runtime(client);
    const handle = await rt.start(spec("r2"));

    expect(handle).toEqual({ adapter: "cloudrun", externalId: EXEC("existing") });
    expect(client.jobs.runJob).not.toHaveBeenCalled();
  });

  it("does not dedup against a terminal execution with the same runId", async () => {
    const client = mockClient();
    const done = fakeExecution(EXEC("old"), "r3", { succeededCount: 1 });
    client.executions.listExecutions.mockResolvedValue([[done]]);
    client.jobs.runJob.mockResolvedValue([{ metadata: fakeExecution(EXEC("new"), "r3") }]);

    const rt = runtime(client);
    const handle = await rt.start(spec("r3"));

    expect(handle.externalId).toBe(EXEC("new"));
    expect(client.jobs.runJob).toHaveBeenCalled();
  });

  it("wait() resolves code 0 on success", async () => {
    const client = mockClient();
    client.executions.getExecution.mockResolvedValue([fakeExecution(EXEC("e1"), "r1", { succeededCount: 1 })]);

    const rt = runtime(client);
    await expect(rt.wait({ adapter: "cloudrun", externalId: EXEC("e1") })).resolves.toEqual({ code: 0 });
  });

  it("wait() reports timeout when the Completed condition mentions the deadline", async () => {
    const client = mockClient();
    client.executions.getExecution.mockResolvedValue([
      fakeExecution(EXEC("e1"), "r1", { failedCount: 1 }, [
        { type: "Completed", reason: "PROGRESS_DEADLINE_EXCEEDED", message: "The execution failed because it exceeded its deadline." },
      ]),
    ]);

    const rt = runtime(client);
    const exit = await rt.wait({ adapter: "cloudrun", externalId: EXEC("e1") });
    expect(exit).toEqual({ code: 137, reason: "timeout" });
  });

  it("cancel() then wait() reports cancelled", async () => {
    const client = mockClient();
    client.executions.getExecution.mockResolvedValue([
      fakeExecution(EXEC("e1"), "r1", { cancelledCount: 1 }, [
        { type: "Completed", executionReason: "CANCELLED", reason: "CANCELLED", message: "cancelled by user" },
      ]),
    ]);

    const rt = runtime(client);
    const handle = { adapter: "cloudrun", externalId: EXEC("e1") };
    await rt.cancel(handle);
    const exit = await rt.wait(handle);
    expect(exit).toEqual({ code: 137, reason: "cancelled" });
  });

  it("wait() reports lost on NOT_FOUND when we did not cancel it", async () => {
    const client = mockClient();
    const err = Object.assign(new Error("not found"), { code: 5 });
    client.executions.getExecution.mockRejectedValue(err);

    const rt = runtime(client);
    const exit = await rt.wait({ adapter: "cloudrun", externalId: EXEC("gone") });
    expect(exit).toEqual({ code: 1, reason: "lost" });
  });

  it("wait() reports cancelled on NOT_FOUND after we cancelled it", async () => {
    const client = mockClient();
    const err = Object.assign(new Error("not found"), { code: 5 });
    client.executions.getExecution.mockRejectedValue(err);

    const rt = runtime(client);
    const handle = { adapter: "cloudrun", externalId: EXEC("gone") };
    await rt.cancel(handle);
    const exit = await rt.wait(handle);
    expect(exit).toEqual({ code: 137, reason: "cancelled" });
  });
});

describe("CloudRunJobRuntime.jobPathFor", () => {
  it("maps the image basename to a per-image Job, ignoring registry, tag and digest", async () => {
    const { CloudRunJobRuntime } = await import("./cloudrun-job.js");
    const rt = new CloudRunJobRuntime({ projectId: "p", region: "r", client: { jobs: {} as never, executions: {} as never } });
    expect(rt.jobPathFor("us-central1-docker.pkg.dev/p/ai-employee/runner:abc")).toBe("projects/p/locations/r/jobs/ai-employee-runner");
    expect(rt.jobPathFor("ai-employee-runner-ops:dev")).toBe("projects/p/locations/r/jobs/ai-employee-runner-ops");
    expect(rt.jobPathFor("registry/x/runner@sha256:deadbeef")).toBe("projects/p/locations/r/jobs/ai-employee-runner");
  });
  it("a jobName override wins over the image basename", async () => {
    const { CloudRunJobRuntime } = await import("./cloudrun-job.js");
    const rt = new CloudRunJobRuntime({ projectId: "p", region: "r", client: { jobs: {} as never, executions: {} as never } });
    expect(rt.jobPathFor("registry/x/runner:abc", "ai-employee-runner-custom")).toBe("projects/p/locations/r/jobs/ai-employee-runner-custom");
  });
});
