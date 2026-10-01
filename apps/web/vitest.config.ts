import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Next's tsconfig uses `jsx: "preserve"` (compiled by SWC); for vitest we
  // transform JSX ourselves so component tests can render .tsx sources.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
