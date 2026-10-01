import { describe, expect, it } from "vitest";
import { toastReducer, TOAST_LIMIT, type ToastItem } from "./toast.js";

const base: Omit<ToastItem, "id"> = { title: "Saved", variant: "info" };

function state(...items: Array<Partial<ToastItem>>): ToastItem[] {
  return items.map((item, index) => ({ ...base, ...item, id: index + 1 }));
}

describe("toastReducer", () => {
  it("push assigns increasing ids", () => {
    let toasts = toastReducer([], { type: "push", toast: base });
    expect(toasts).toHaveLength(1);
    toasts = toastReducer(toasts, { type: "push", toast: { title: "Again", variant: "success" } });
    expect(toasts.map((toast) => toast.id)).toEqual([1, 2]);
    expect(toasts[1]).toMatchObject({ title: "Again", variant: "success" });
  });

  it("caps the stack at the limit, dropping the oldest", () => {
    let toasts: ToastItem[] = [];
    for (let i = 0; i < TOAST_LIMIT + 2; i += 1) {
      toasts = toastReducer(toasts, { type: "push", toast: { ...base, title: `t${i}` } });
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
