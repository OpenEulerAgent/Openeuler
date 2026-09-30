export const PACKAGE_NAME = "@openeuler/engine";

export const ENGINE_VERSION = "0.0.0";

export function nextTick(previous: number): { tick: number } {
  return { tick: previous + 1 };
}
