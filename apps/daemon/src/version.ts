import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function getVersion(): string {
  if (cached) return cached;
  try {
    const raw = readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    cached = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
