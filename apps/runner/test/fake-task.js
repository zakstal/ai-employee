// Fixture child process for server.test.ts. Sleeps FAKE_SLEEP_MS then exits
// FAKE_EXIT. Relies on Node's default SIGTERM/SIGKILL handling (immediate
// termination) to simulate a cancelled/timed-out run.
const exitCode = Number(process.env.FAKE_EXIT ?? "0");
const sleepMs = Number(process.env.FAKE_SLEEP_MS ?? "0");
setTimeout(() => process.exit(exitCode), sleepMs);
