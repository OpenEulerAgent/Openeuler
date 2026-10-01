"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

/**
 * Toast system (issue #50): provider + `useToast()` hook + fixed viewport.
 * All logic flows through the pure {@link toastReducer}; the provider only
 * wires timers for auto-dismiss (with cleanup) and renders the viewport.
 */

export type ToastVariant = "info" | "success" | "danger";

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

export type ToastAction =
  { type: "push"; toast: Omit<ToastItem, "id"> } | { type: "dismiss"; id: number };

/** Never show more than this many stacked toasts (oldest dropped). */
export const TOAST_LIMIT = 5;

export const DEFAULT_TOAST_DURATION_MS = 5000;

export function toastReducer(state: ToastItem[], action: ToastAction): ToastItem[] {
  switch (action.type) {
    case "push": {
      const id = state.reduce((max, toast) => Math.max(max, toast.id), 0) + 1;
      const next = [...state, { ...action.toast, id }];
      return next.length > TOAST_LIMIT ? next.slice(next.length - TOAST_LIMIT) : next;
    }
    case "dismiss":
      return state.filter((toast) => toast.id !== action.id);
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
  const [timers, setTimers] = useState<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: number) => {
    setTimers((current) => {
      const timer = current.get(id);
      if (timer) clearTimeout(timer);
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);

  const toast = useCallback(
    (toastInput: Omit<ToastItem, "id">, durationMs: number = DEFAULT_TOAST_DURATION_MS) => {
      const before = toasts.reduce((max, toastItem) => Math.max(max, toastItem.id), 0) + 1;
      dispatch({ type: "push", toast: toastInput });
      if (durationMs <= 0) return;
      const timer = setTimeout(() => {
        dispatch({ type: "dismiss", id: before });
        setTimers((current) => {
          const next = new Map(current);
          next.delete(before);
          return next;
        });
      }, durationMs);
      setTimers((current) => new Map(current).set(before, timer));
    },
    [toasts],
  );

  // Cleanup all pending timers on unmount.
  useEffect(() => {
    const pending = timers;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, [timers]);

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
                clearTimer(toastItem.id);
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
