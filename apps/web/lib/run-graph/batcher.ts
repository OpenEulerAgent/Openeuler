import { EMPTY_RUN_GRAPH_STATE, foldRunGraphEvent, type RunGraphFoldState } from "./fold";
import type { RunStreamEvent } from "@/lib/run-events";

/**
 * Throttled fold applicator (#52 performance): SSE events fold into an
 * internal state immediately (cheap object upserts), but React state
 * updates are batched — AT MOST one `onState` emission per interval window,
 * so a 500-event replay burst cannot trigger 500 graph re-renders.
 *
 * `state` always reflects every event pushed so far (imperative reads stay
 * correct); emissions are the throttled part.
 */

export const FOLD_BATCH_INTERVAL_MS = 125;

export interface FoldBatcherOptions {
  /** Called with the folded state at most once per interval. */
  onState: (state: RunGraphFoldState) => void;
  /** Batch window in ms; defaults to {@link FOLD_BATCH_INTERVAL_MS}. */
  intervalMs?: number;
  /** Initial state (a previous fold / replay); defaults to empty. */
  initial?: RunGraphFoldState;
  /** Timer scheduler, injectable for tests. Defaults to `setTimeout`. */
  schedule?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

type ScheduleFn = (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
type CancelFn = (timer: ReturnType<typeof setTimeout>) => void;

export class RunGraphFoldBatcher {
  readonly #onState: (state: RunGraphFoldState) => void;
  readonly #intervalMs: number;
  readonly #schedule: ScheduleFn;
  readonly #cancel: CancelFn;
  #state: RunGraphFoldState;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #dirty = false;
  #disposed = false;

  constructor(options: FoldBatcherOptions) {
    this.#onState = options.onState;
    this.#intervalMs = options.intervalMs ?? FOLD_BATCH_INTERVAL_MS;
    this.#schedule =
      (options.schedule as ScheduleFn | undefined) ?? ((handler, ms) => setTimeout(handler, ms));
    this.#cancel = (options.cancel as CancelFn | undefined) ?? ((timer) => clearTimeout(timer));
    this.#state = options.initial ?? { ...EMPTY_RUN_GRAPH_STATE };
  }

  /** The state including every pushed event (never throttled). */
  get state(): RunGraphFoldState {
    return this.#state;
  }

  /** Folds one event; schedules an emission if none is pending. */
  push(event: RunStreamEvent): void {
    if (this.#disposed) return;
    this.#state = foldRunGraphEvent(this.#state, event);
    this.#dirty = true;
    if (this.#timer === null) {
      this.#timer = this.#schedule(() => this.#emit(), this.#intervalMs);
    }
  }

  /** Emits immediately when dirty (terminal event, unmount, tests). */
  flush(): void {
    if (this.#timer !== null) {
      this.#cancel(this.#timer);
      this.#timer = null;
    }
    this.#emit();
  }

  /** Stops the pending emission and drops future pushes. */
  dispose(): void {
    if (this.#timer !== null) {
      this.#cancel(this.#timer);
      this.#timer = null;
    }
    this.#disposed = true;
  }

  #emit(): void {
    this.#timer = null;
    if (this.#disposed || !this.#dirty) return;
    this.#dirty = false;
    this.#onState(this.#state);
  }
}
