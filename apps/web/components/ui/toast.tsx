"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

/**
 * Toast system (issue #50): provider + `useToast()` hook + fixed viewport.
 * All logic flows through the pure {@link toastReducer}; the provider only
 * wires auto-dismiss timers through the {@link ToastTimers} controller and
 * renders the viewport.
 */

export type ToastVariant = "info" | "success" | "danger";

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

export type ToastAction = { type: "push"; toast: ToastItem } | { type: "dismiss"; id: number };

/** Never show more than this many stacked toasts (oldest dropped). */
export const TOAST_LIMIT = 5;

export const DEFAULT_TOAST_DURATION_MS = 5000;

export function toastReducer(state: ToastItem[], action: ToastAction): ToastItem[] {
  switch (action.type) {
    case "push": {
      if (state.some((toast) => toast.id === action.toast.id)) return state;
      const next = [...state, action.toast];
      return next.length > TOAST_LIMIT ? next.slice(next.length - TOAST_LIMIT) : next;
    }
    case "dismiss":
      return state.filter((toast) => toast.id !== action.id);
  }
}

export interface ToastScheduler {
  set: (callback: () => void, durationMs: number) => unknown;
  clear: (handle: unknown) => void;
}

const DEFAULT_SCHEDULER: ToastScheduler = {
  set: (callback, durationMs) => setTimeout(callback, durationMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One timeout per toast id (ids come from a provider-side counter): `sync`
 * creates timers for toasts lacking one and clears the ones that left the
 * stack, `dismiss` clears a single toast's timer, `dispose` clears all
 * (unmount). Duration <= 0 means "never auto-dismiss".
 */
export class ToastTimers {
  private handles = new Map<number, unknown>();
  private durations = new Map<number, number>();

  constructor(private scheduler: ToastScheduler = DEFAULT_SCHEDULER) {}

  setDuration(id: number, durationMs: number): void {
    this.durations.set(id, durationMs);
  }

  sync(toasts: ReadonlyArray<Pick<ToastItem, "id">>, onExpire: (id: number) => void): void {
    for (const toast of toasts) {
      if (this.handles.has(toast.id)) continue;
      const durationMs = this.durations.get(toast.id) ?? DEFAULT_TOAST_DURATION_MS;
      const handle =
        durationMs > 0
          ? this.scheduler.set(() => {
              this.handles.delete(toast.id);
              this.durations.delete(toast.id);
              onExpire(toast.id);
            }, durationMs)
          : null;
      this.handles.set(toast.id, handle);
    }
    const live = new Set(toasts.map((toast) => toast.id));
    for (const id of [...this.handles.keys()]) {
      if (!live.has(id)) this.clear(id);
    }
  }

  /** Manual dismiss: stop the auto-dismiss timer for one toast. */
  dismiss(id: number): void {
    this.clear(id);
    this.durations.delete(id);
  }

  /** Clear every pending timer (provider unmount). */
  dispose(): void {
    for (const id of [...this.handles.keys()]) this.clear(id);
  }

  pending(): number[] {
    return [...this.handles.keys()];
  }

  private clear(id: number): void {
    const handle = this.handles.get(id);
    if (handle !== null && handle !== undefined) this.scheduler.clear(handle);
    this.handles.delete(id);
    this.durations.delete(id);
  }
}

interface ToastContextValue {
  toast: (toast: Omit<ToastItem, "id">, durationMs?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within <ToastProvider>");
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const timersRef = useRef<ToastTimers | null>(null);
  if (timersRef.current === null) timersRef.current = new ToastTimers();
  const nextIdRef = useRef(0);

  const toast = useCallback(
    (toastInput: Omit<ToastItem, "id">, durationMs: number = DEFAULT_TOAST_DURATION_MS) => {
      nextIdRef.current += 1;
      const id = nextIdRef.current;
      timersRef.current?.setDuration(id, durationMs);
      dispatch({ type: "push", toast: { ...toastInput, id } });
    },
    [],
  );

  // Single owner of the timer map: schedule what's new, stop what's gone.
  useEffect(() => {
    timersRef.current?.sync(toasts, (id) => dispatch({ type: "dismiss", id }));
  }, [toasts]);

  // Clear all pending timers on unmount.
  useEffect(() => () => timersRef.current?.dispose(), []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-80 flex-col gap-2"
      >
        {toasts.map((toastItem) => (
          <div
            key={toastItem.id}
            role={toastItem.variant === "danger" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex items-start justify-between gap-3 rounded-lg border px-4 py-3 shadow-2",
              toastItem.variant === "success" && "border-success/40 bg-success-subtle text-success",
              toastItem.variant === "danger" && "border-danger/40 bg-danger-subtle text-danger",
              toastItem.variant === "info" && "border-border bg-elevated text-fg",
            )}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{toastItem.title}</p>
              {toastItem.description ? (
                <p className="mt-0.5 text-xs opacity-80">{toastItem.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => {
                timersRef.current?.dismiss(toastItem.id);
                dispatch({ type: "dismiss", id: toastItem.id });
              }}
              className="rounded p-0.5 text-current opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className="size-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
