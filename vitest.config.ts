import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          dir: "packages/opencode-orchestrator-runtime/src/core",
          include: ["**/*.test.ts"],
        },
      },
      {
        test: {
          name: "runtime",
          dir: "packages/opencode-orchestrator-runtime/test",
          include: ["**/*.test.ts"],
          exclude: ["live/**"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "live",
          dir: "packages/opencode-orchestrator-runtime/test/live",
          include: ["**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 900_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
