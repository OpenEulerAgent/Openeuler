import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The docker contract/integration suites start and stop real containers;
    // the default 5s ceiling is too tight for cold-start pulls and 10s stop
    // graces. Unit tests stay well under these bounds regardless.
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
