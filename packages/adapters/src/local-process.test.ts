import { describe, expect, it } from "vitest";
import { LocalProcessRuntime } from "./local-process.js";

import type { RunSpec } from "@ai-employee/core";
const spec = (runId: string, script: string, timeoutSec = 5): RunSpec => ({
  runId,
  image: "n/a",
  env: { GREETING: "hi" },
  cpu: 1,
  memoryMb: 128,
  timeoutSec,
  employeeId: "e1",
  command: ["sh", "-c", script],
});

describe("LocalProcessRuntime", () => {
  const rt = new LocalProcessRuntime((s) => s.command ?? ["sh", "-c", "exit 0"]);

  it("propagates exit code and env", async () => {
    const h = await rt.start(spec("r1", 'test "$GREETING" = hi && exit 3'));
    expect(await rt.wait(h)).toEqual({ code: 3 });
  });

  it("is idempotent on start for the same runId", async () => {
    await rt.start(spec("r2", "sleep 0.2"));
    const h2 = await rt.start(spec("r2", "exit 9"));
    expect(await rt.wait(h2)).toEqual({ code: 0 });
  });

  it("kills on timeout", async () => {
    const h = await rt.start(spec("r3", "sleep 5", 1));
    expect((await rt.wait(h)).reason).toBe("timeout");
  });

  it("cancels", async () => {
    const h = await rt.start(spec("r4", "sleep 5"));
    await rt.cancel(h);
    expect((await rt.wait(h)).reason).toBe("cancelled");
  });
});
