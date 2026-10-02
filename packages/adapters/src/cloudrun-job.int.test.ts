import { describe, expect, it } from "vitest";
import type { RunSpec } from "@ai-employee/core";
import { CloudRunJobRuntime } from "./cloudrun-job.js";

const TEST_TIMEOUT = 5 * 60_000;

/**
 * Requires a real Cloud Run Job + Application Default Credentials.
 * v2 RunJobRequest.Overrides only supports `args`, not `command` — so this
 * only works if the Job's image entrypoint runs its args as a shell command.
 * That may not hold for the real ai-employee-runner image, so this test
 * makes no assumption about the container's actual behavior: it only checks
 * that wait() reaches SOME terminal state within the timeout.
 */
describe.skipIf(process.env.CLOUDRUN_INT !== "1")("CloudRunJobRuntime (real Cloud Run)", () => {
  const runtime = () =>
    new CloudRunJobRuntime({
      projectId: process.env.GCP_PROJECT ?? "",
      region: process.env.GCP_REGION ?? "",
      jobName: process.env.CLOUDRUN_JOB ?? "",
      pollIntervalMs: 3000,
    });

  it(
    "reaches a terminal state",
    async () => {
      const rt = runtime();
      const spec: RunSpec = {
        runId: `int-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        image: "unused", // Job's configured image is used; this is ignored (see warnOnImageMismatch)
        env: {},
        cpu: 1,
        memoryMb: 512,
        timeoutSec: 120,
        employeeId: "test",
        command: ["/bin/sh", "-c", "echo hi && exit 0"],
      };

      const handle = await rt.start(spec);
      const exit = await rt.wait(handle);
      expect(exit.code).toBeTypeOf("number");
      console.log("int test observed exit:", JSON.stringify(exit));
    },
    TEST_TIMEOUT,
  );
});
