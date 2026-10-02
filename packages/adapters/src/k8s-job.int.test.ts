import { describe, expect, it } from "vitest";
import type { RunSpec } from "@ai-employee/core";
import { KubernetesJobRuntime } from "./k8s-job.js";

const TEST_TIMEOUT = 120_000;

const baseSpec = (overrides: Partial<RunSpec>): RunSpec => ({
  runId: `int-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  image: "busybox:1.36",
  env: {},
  cpu: 0.1,
  memoryMb: 64,
  timeoutSec: 60,
  employeeId: "test",
  ...overrides,
});

describe.skipIf(process.env.K8S_INT !== "1")("KubernetesJobRuntime (kind cluster)", () => {
  const runtime = () =>
    new KubernetesJobRuntime({
      namespaceFor: () => "ai-emp-test",
      ttlSecondsAfterFinished: 30,
      pollIntervalMs: 500,
      runAsNonRoot: false,
    });

  it(
    "exits 0 on success",
    async () => {
      const rt = runtime();
      const spec = baseSpec({
        command: ["sh", "-c", 'test "$GREETING" = hi && exit 0'],
        env: { GREETING: "hi" },
      });
      const handle = await rt.start(spec);
      const exit = await rt.wait(handle);
      expect(exit.code).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "propagates a non-zero exit code",
    async () => {
      const rt = runtime();
      const spec = baseSpec({ command: ["sh", "-c", "exit 3"] });
      const handle = await rt.start(spec);
      const exit = await rt.wait(handle);
      expect(exit.code).not.toBe(0);
      // Report what k8s actually gives back for this case.
      console.log("case (2) observed exit:", JSON.stringify(exit));
    },
    TEST_TIMEOUT,
  );

  it(
    "reports timeout when activeDeadlineSeconds is exceeded",
    async () => {
      const rt = runtime();
      const spec = baseSpec({ command: ["sh", "-c", "sleep 60"], timeoutSec: 5 });
      const handle = await rt.start(spec);
      const exit = await rt.wait(handle);
      expect(exit.reason).toBe("timeout");
    },
    TEST_TIMEOUT,
  );

  it(
    "reports cancelled after cancel()",
    async () => {
      const rt = runtime();
      const spec = baseSpec({ command: ["sh", "-c", "sleep 60"] });
      const handle = await rt.start(spec);
      await rt.cancel(handle);
      const exit = await rt.wait(handle);
      expect(exit.reason).toBe("cancelled");
    },
    TEST_TIMEOUT,
  );

  it(
    "starting the same runId twice does not throw",
    async () => {
      const rt = runtime();
      const spec = baseSpec({ command: ["sh", "-c", "exit 0"] });
      await expect(rt.start(spec)).resolves.toBeDefined();
      await expect(rt.start(spec)).resolves.toBeDefined();
    },
    TEST_TIMEOUT,
  );
});
