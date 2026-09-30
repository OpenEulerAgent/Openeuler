import type { AgentEvent } from "@openeuler/core";
import { DriverError } from "./error.js";
import type { AgentDriver, AgentExit, AgentHandle, AgentStartOpts } from "./types.js";

/** Construction options for {@link createFakeDriver}. */
export interface FakeDriverOptions {
  /** Registry id; defaults to `"fake"`. */
  id?: string;
  /** Script replayed in order. A `started` event (seq 0) is prepended when missing. */
  events?: AgentEvent[];
  /** Delay between events in ms; `0` (default) emits immediately. */
  delayMs?: number;
  /** Final output reported by `exited` on normal completion. Defaults to accumulated text. */
  output?: string;
  /** Exit code reported by `exited` on normal completion. Defaults to `0`. */
  exitCode?: number;
  /** When true, `abort()` rejects with `DriverError` (`DRIVER_ABORT_FAILED`). */
  failOnAbort?: boolean;
}

interface FakeHandleConfig {
  id: string;
  script: readonly AgentEvent[];
  delayMs: number;
  output?: string;
  exitCode?: number;
  failOnAbort: boolean;
}

type HandleState = "running" | "completed" | "aborted";

class FakeAgentHandle implements AgentHandle {
  private readonly config: FakeHandleConfig;
  private state: HandleState = "running";
  private iterated = false;
  private outputSoFar = "";
  private sleepInterrupt: (() => void) | null = null;
  private resolveExit!: (exit: AgentExit) => void;

  readonly events: AsyncIterable<AgentEvent>;
  readonly exited: Promise<AgentExit>;

  constructor(config: FakeHandleConfig) {
    this.config = config;
    this.exited = new Promise<AgentExit>((resolve) => {
      this.resolveExit = resolve;
    });
    const stream = this.stream();
    this.events = {
      [Symbol.asyncIterator]: (): AsyncIterator<AgentEvent> => {
        if (this.iterated) {
          throw new DriverError(
            "DRIVER_EVENTS_ALREADY_CONSUMED",
            `fake driver "${config.id}" handle events were already iterated; an AgentHandle supports a single consumer`,
          );
        }
        this.iterated = true;
        return stream[Symbol.asyncIterator]();
      },
    };
  }

  async abort(): Promise<void> {
    if (this.state !== "running") return;
    if (this.config.failOnAbort) {
      throw new DriverError(
        "DRIVER_ABORT_FAILED",
        `fake driver "${this.config.id}" failed to abort`,
      );
    }
    this.state = "aborted";
    this.interruptSleep();
    this.resolveExit({ code: null, reason: "aborted", output: this.outputSoFar });
  }

  private interruptSleep(): void {
    this.sleepInterrupt?.();
    this.sleepInterrupt = null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.sleepInterrupt = null;
        resolve();
      }, ms);
      this.sleepInterrupt = () => {
        clearTimeout(timer);
        this.sleepInterrupt = null;
        resolve();
      };
    });
  }

  private captureOutput(event: AgentEvent): void {
    if (event.type === "message-delta") {
      this.outputSoFar += event.delta;
    } else if (event.type === "tool-output") {
      this.outputSoFar += event.output;
    }
  }

  private async *stream(): AsyncGenerator<AgentEvent, void> {
    const { script, delayMs } = this.config;
    try {
      for (const event of script) {
        if (this.state !== "running") return;
        if (delayMs > 0) {
          await this.sleep(delayMs);
          if (this.state !== "running") return;
        }
        this.captureOutput(event);
        yield event;
      }
      this.state = "completed";
      this.resolveExit({
        code: this.config.exitCode ?? 0,
        reason: "exit",
        output: this.config.output ?? this.outputSoFar,
      });
    } finally {
      // Reaching here without completing the script means the consumer stopped
      // early (break/throw) or the run was aborted: never leave `exited` pending.
      this.interruptSleep();
      if (this.state === "running") {
        this.state = "aborted";
        this.resolveExit({ code: null, reason: "aborted", output: this.outputSoFar });
      }
    }
  }
}

/**
 * Scripted in-memory driver for tests: replays `events` in order, then resolves
 * `exited`. Records every {@link AgentStartOpts} in {@link FakeDriver.calls}.
 */
export class FakeDriver implements AgentDriver {
  readonly id: string;
  /** Every `AgentStartOpts` received by `start()`, in call order. */
  readonly calls: AgentStartOpts[] = [];

  private readonly options: FakeDriverOptions;

  constructor(options: FakeDriverOptions = {}) {
    this.id = options.id ?? "fake";
    this.options = options;
  }

  start(opts: AgentStartOpts): AgentHandle {
    this.calls.push(opts);
    const script = this.options.events ?? [];
    const effective: AgentEvent[] =
      script[0]?.type === "started" ? [...script] : [{ type: "started", seq: 0 }, ...script];
    return new FakeAgentHandle({
      id: this.id,
      script: effective,
      delayMs: Math.max(0, this.options.delayMs ?? 0),
      output: this.options.output,
      exitCode: this.options.exitCode,
      failOnAbort: this.options.failOnAbort ?? false,
    });
  }
}

/** Create a scripted fake driver. */
export function createFakeDriver(options: FakeDriverOptions = {}): FakeDriver {
  return new FakeDriver(options);
}
