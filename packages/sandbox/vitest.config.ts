import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The docker contract/integration suites start and stop real containers;
    // the default 5s ceiling is too tight for cold-start pulls and 10s stop
    // graces. Unit tests stay well under these bounds regardless.
    testTimeout: 60_000,
    hookTimeout: 300_000,
    // Both real-docker suites manage containers concurrently; running the
    // files in parallel workers makes `docker stats/ps` race container
    // removal from the sibling suite and flake. Real-docker work is
    // serialized (unit files pay only a small startup cost).
    fileParallelism: false,
  },
});
