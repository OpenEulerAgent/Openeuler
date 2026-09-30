export const PACKAGE_NAME = "@openeuler/db";

export type DbResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function success<T>(value: T): DbResult<T> {
  return { ok: true, value };
}

export function failure(error: string): DbResult<never> {
  return { ok: false, error };
}
