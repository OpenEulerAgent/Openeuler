import { getVersion } from "./version.js";

export interface HealthPayload {
  ok: boolean;
  version: string;
  uptime: number;
}

export function healthPayload(): HealthPayload {
  return {
    ok: true,
    version: getVersion(),
    uptime: Math.floor(process.uptime()),
  };
}
