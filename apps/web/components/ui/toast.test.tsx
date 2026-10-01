import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TOAST_DURATION_MS,
  ToastTimers,
  toastReducer,
  TOAST_LIMIT,
  type ToastItem,
} from "./toast.js";

const base: Omit<ToastItem, "id"> = { title: "Saved", variant: "info" };

function state(...items: Array<Partial<ToastItem>>): ToastItem[] {
  return items.map((item, index) => ({ ...base, ...item, id: index + 1 }));
}

describe("toastReducer", () => {
  it("push appends the toast with its counter-assigned id", () => {
    let toasts = toastReducer([], { type: "push", toast: { ...base, id: 1 } });
    expect(toasts).toHaveLength(1);
    toasts = toastReducer(toasts, {
      type: "push",
      toast: { title: "Again", variant: "success", id: 2 },
    });
    expect(toasts.map((toast) => toast.id)).toEqual([1, 2]);
    expect(toasts[1]).toMatchObject({ title: "Again", variant: "success" });
  });

  it("push of a duplicate id is a no-op (StrictMode-safe)", () => {
    const toasts = state({}, {});
    expect(toastReducer(toasts, { type: "push", toast: { ...base, id: 1 } })).toEqual(toasts);
  });

  it("caps the stack at the limit, dropping the oldest", () => {
    let toasts: ToastItem[] = [];
    for (let i = 0; i < TOAST_LIMIT + 2; i += 1) {
      toasts = toastReducer(toasts, {
        type: "push",
        toast: { ...base, title: `t${i}`, id: i + 1 },
      });
    }
    expect(toasts).toHaveLength(TOAST_LIMIT);
    expect(toasts.map((toast) => toast.title)).toEqual([
      `t${TOAST_LIMIT - 3}`,
      `t${TOAST_LIMIT - 2}`,
      `t${TOAST_LIMIT - 1}`,
      `t${TOAST_LIMIT}`,
      `t${TOAST_LIMIT + 1}`,
    ]);
  });

  it("dismiss removes only the targeted toast", () => {
    let toasts = state({}, { title: "Keep" }, {});
    toasts = toastReducer(toasts, { type: "dismiss", id: 2 });
    expect(toasts.map((toast) => toast.id)).toEqual([1, 3]);
  });

  it("dismiss of an unknown id is a no-op", () => {
    const toasts = state({}, {});
    expect(toastReducer(toasts, { type: "dismiss", id: 99 })).toEqual(toasts);
  });
});

describe("ToastTimers (auto-dismiss model)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function stack(...ids: number[]): ToastItem[] {
    return ids.map((id) => ({ ...base, id }));
  }

  it("two toasts pushed in one tick both auto-dismiss", () => {
    const timers = new ToastTimers();
    const dismissed: number[] = [];
    timers.sync(stack(1, 2), (id) => dismissed.push(id));
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS);
    expect(dismissed).toEqual([1, 2]);
  });

  it("dismissing one toast does not kill the other's timer", () => {
    const timers = new ToastTimers();
    const dismissed: number[] = [];
    timers.sync(stack(1, 2), (id) => dismissed.push(id));
    timers.dismiss(1);
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS);
    expect(dismissed).toEqual([2]);
  });

  it("sync clears the timer of a toast that left the stack", () => {
    const timers = new ToastTimers();
    const dismissed: number[] = [];
    const expire = (id: number) => {
      dismissed.push(id);
    };
    timers.sync(stack(1, 2), expire);
    timers.sync(stack(2), expire);
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS * 2);
    expect(dismissed).toEqual([2]);
  });

  it("dispose (unmount) clears every pending timer", () => {
    const timers = new ToastTimers();
    const dismissed: number[] = [];
    timers.sync(stack(1, 2), (id) => dismissed.push(id));
    timers.dispose();
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS * 2);
    expect(dismissed).toEqual([]);
    expect(timers.pending()).toEqual([]);
  });

  it("does not reschedule timers that already exist (countdown is not reset)", () => {
    const timers = new ToastTimers();
    const dismissed: number[] = [];
    const expire = (id: number) => {
      dismissed.push(id);
    };
    timers.sync(stack(1), expire);
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS - 1000);
    timers.sync(stack(1), expire);
    vi.advanceTimersByTime(1000);
    expect(dismissed).toEqual([1]);
  });

  it("honors per-toast durations and never dismisses duration <= 0", () => {
    const timers = new ToastTimers();
    const dismissed: number[] = [];
    const expire = (id: number) => {
      dismissed.push(id);
    };
    timers.setDuration(1, 250);
    timers.setDuration(2, 0);
    timers.sync(stack(1, 2), expire);
    vi.advanceTimersByTime(250);
    expect(dismissed).toEqual([1]);
  });
});
