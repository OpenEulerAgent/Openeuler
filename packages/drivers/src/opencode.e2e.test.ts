import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "@openeuler/core";
import { checkOpenCodeInstalled, createOpenCodeDriver } from "./opencode.js";

const runE2E = process.env.AGENT_E2E === "1";
const e2eDirs: string[] = [];

afterAll(() => {
  for (const dir of e2eDirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!runE2E)("OpenCodeDriver e2e (requires real opencode; set AGENT_E2E=1)", () => {
  it("runs a real opencode session that edits a file in the worktree", async () => {
    await checkOpenCodeInstalled();
    const cwd = mkdtempSync(join(tmpdir(), "opencode-e2e-"));
    e2eDirs.push(cwd);
    writeFileSync(join(cwd, "README.md"), "# scratch project\n");

    const driver = createOpenCodeDriver();
    const handle = driver.start({
      cwd,
      prompt:
        "Create a file named result.txt in the working directory containing exactly the text: opencode-driver-ok",
      mode: "auto",
      ...(process.env.OPENCODE_TEST_MODEL ? { model: process.env.OPENCODE_TEST_MODEL } : {}),
    });

    const events: AgentEvent[] = [];
    for await (const event of handle.events) events.push(event);
    const exit = await handle.exited;

    expect(exit).toEqual({ code: 0, reason: "exit", output: exit.output });
    expect(events.map((event) => event.type)).toContain("session");
    expect(events.at(-1)?.type).toBe("done");
    expect(existsSync(join(cwd, "result.txt"))).toBe(true);
  }, 300_000);
});
