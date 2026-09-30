import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const rootDir = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: rootDir });

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "**/coverage/",
      "**/.next/",
      "**/out/",
      "**/next-env.d.ts",
      "pnpm-lock.yaml",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.tsx"],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    // Next.js plugin (via eslint-config-next) so `next build` recognizes the
    // setup and lints the app router pages. Registered globally — `next build`
    // probes the merged config of this very file for the `@next/next` plugin,
    // which a `files:`-scoped block would hide. rootDir is absolute so the
    // plugin resolves apps/web regardless of the linting cwd.
    settings: {
      next: { rootDir: `${rootDir}/apps/web` },
    },
    extends: compat.extends("next/core-web-vitals"),
  },
  {
    // Pins the react version eslint-config-next would otherwise try to detect
    // (and fail, since react is not resolvable from the repo root).
    settings: { react: { version: "19" } },
  },
);
