export interface HealthPayload {
  ok: boolean;
  service: string;
}

export function healthPayload(): HealthPayload {
  return { ok: true, service: "@openeuler/daemon" };
}
