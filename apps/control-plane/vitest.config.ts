import { defineConfig } from "vitest/config";
export default defineConfig({ test: { fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000, env: { LOG_LEVEL: "silent" } } });
