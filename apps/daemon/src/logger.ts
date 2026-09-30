import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level?: string): Logger {
  return pino({ level: level ?? process.env["LOG_LEVEL"] ?? "info" });
}
