import { describe, expect, it, vi } from "vitest";
import type { RunSpec } from "@ai-employee/core";
import { CloudRunJobRuntime } from "./cloudrun-job.js";
import { CloudLoggingReader } from "./cloud-logging.js";

type Client = NonNullable<ConstructorParameters<typeof CloudRunJobRuntime>[0]["client"]>;
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
  return { jobs, executions };
}

function runtime(client: ReturnType<typeof mockClient>) {
  return new CloudRunJobRuntime({ projectId: "p1", region: "us-central1", client: client as unknown as Client });
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

  describe("status", () => {
    const handle = { adapter: "cloudrun", externalId: EXEC("e1") };
    it("running: a non-terminal execution, with its start time", async () => {
      const client = mockClient();
      client.executions.getExecution.mockResolvedValue([{ ...fakeExecution(EXEC("e1"), "r1"), startTime: { seconds: "1767225600", nanos: 0 } }]);
      expect(await runtime(client).status(handle)).toEqual({ state: "running", startedAt: "2026-01-01T00:00:00.000Z" });
    });
    it("ended: succeeded is exit 0 with start and completion times", async () => {
      const client = mockClient();
      client.executions.getExecution.mockResolvedValue([{ ...fakeExecution(EXEC("e1"), "r1", { succeededCount: 1 }), startTime: { seconds: 1767225600 }, completionTime: { seconds: 1767225660 } }]);
      expect(await runtime(client).status(handle)).toEqual({ state: "ended", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z", exitCode: 0 });
    });
    it("ended: a failed execution reports exit 1 and the platform's reason", async () => {
      const client = mockClient();
      client.executions.getExecution.mockResolvedValue([fakeExecution(EXEC("e1"), "r1", { failedCount: 1 }, [{ type: "Completed", reason: "ContainerFailed" }])]);
      expect(await runtime(client).status(handle)).toEqual({ state: "ended", exitCode: 1, reason: "ContainerFailed" });
    });
    it("lost: the execution no longer exists", async () => {
      const client = mockClient();
      client.executions.getExecution.mockRejectedValue(Object.assign(new Error("not found"), { code: 5 }));
      expect(await runtime(client).status(handle)).toEqual({ state: "lost" });
    });
  });

  describe("logs", () => {
    it("asks the log reader for this execution's tail, by project/job/execution name", async () => {
      const tail = vi.fn().mockResolvedValue(["l1", "l2"]);
      const rt = new CloudRunJobRuntime({ projectId: "p1", region: "us-central1", client: mockClient() as unknown as Client, logReader: { tail } });
      expect(await rt.logs({ adapter: "cloudrun", externalId: EXEC("e1") }, { tail: 50 })).toEqual(["l1", "l2"]);
      expect(tail).toHaveBeenCalledWith({ projectId: "p1", jobName: "ai-employee-runner", executionName: "e1" }, 50);
    });
    it("rejects an execution name it cannot parse", async () => {
      const rt = new CloudRunJobRuntime({ projectId: "p1", region: "us-central1", client: mockClient() as unknown as Client, logReader: { tail: vi.fn() } });
      await expect(rt.logs({ adapter: "cloudrun", externalId: "weird" }, { tail: 5 })).rejects.toThrow("cannot read logs");
    });
  });
});

describe("CloudLoggingReader", () => {
  const ref = { projectId: "p1", jobName: "ai-employee-runner", executionName: "ai-employee-runner-abc12" };
  it("POSTs a filtered entries:list with the bearer token and returns lines oldest first", async () => {
    const fetchImpl = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { filter: string; pageSize: number; resourceNames: string[]; orderBy: string };
      expect(body.resourceNames).toEqual(["projects/p1"]);
      expect(body.filter).toContain('labels."run.googleapis.com/execution_name"="ai-employee-runner-abc12"');
      expect(body.filter).toContain('resource.labels.job_name="ai-employee-runner"');
      expect(body).toMatchObject({ pageSize: 2, orderBy: "timestamp desc" });
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer fake-token");
      return new Response(JSON.stringify({ entries: [{ timestamp: "T2", textPayload: "second" }, { timestamp: "T1", jsonPayload: { message: "first" } }] }), { status: 200 });
    });
    const reader = new CloudLoggingReader({ getToken: async () => "fake-token", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await reader.tail(ref, 2)).toEqual(["T1 first", "T2 second"]);
  });
  it("throws on an API error and refuses odd resource names", async () => {
    const reader = new CloudLoggingReader({ getToken: async () => "t", fetchImpl: (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch });
    await expect(reader.tail(ref, 5)).rejects.toThrow("HTTP 403");
    await expect(reader.tail({ ...ref, executionName: 'x" OR 1=1 --' }, 5)).rejects.toThrow("odd resource name");
  });
});
