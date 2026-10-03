import { describe, expect, it, vi } from "vitest";
import {
  extendRunHosting,
  hostingBannerText,
  hostingCountdownLabel,
  hostingRemainingMs,
  isRunHosted,
  stopRunHosting,
} from "./hosting";

/**
 * Hosted-run web helpers (#110): countdown formatting, the banner headline,
 * the hosted check for table badges, and the stop/extend API clients
 * (injectable fetcher, no browser needed).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("hostingCountdownLabel (#110)", () => {
  const until = new Date(Date.parse("2026-01-01T12:00:00.000Z") + HOUR).toISOString();
  const base = Date.parse("2026-01-01T12:00:00.000Z");

  it("labels sub-minute remainders, minutes, and padded hour+minutes", () => {
    expect(hostingCountdownLabel(until, base + HOUR - 59_000)).toBe("<1m");
    expect(hostingCountdownLabel(until, base + HOUR - 60_000)).toBe("1m");
    expect(hostingCountdownLabel(until, base + 1 * MINUTE)).toBe("59m");
    expect(hostingCountdownLabel(until, base + 18 * MINUTE)).toBe("42m");
    expect(hostingCountdownLabel(until, base)).toBe("1h 00m");
    expect(hostingCountdownLabel(until, base + 5 * MINUTE)).toBe("55m");
    expect(hostingCountdownLabel(new Date(base + 90 * MINUTE).toISOString(), base)).toBe("1h 30m");
    expect(hostingCountdownLabel(new Date(base + 23 * HOUR + 59 * MINUTE).toISOString(), base)).toBe(
      "23h 59m",
    );
  });

  it("reports expired at and past the timestamp; remainingMs is signed", () => {
    expect(hostingCountdownLabel(until, base + HOUR)).toBe("expired");
    expect(hostingCountdownLabel(until, base + 2 * HOUR)).toBe("expired");
    expect(hostingRemainingMs(until, base + HOUR)).toBe(0);
    expect(hostingRemainingMs(until, base + HOUR + 5_000)).toBe(-5_000);
  });
});

describe("hostingBannerText (#110)", () => {
  it("composes the prescribed headline", () => {
    const until = new Date(Date.now() + 42 * MINUTE).toISOString();
    expect(hostingBannerText(until, Date.now())).toMatch(
      /^Hosted — preview live · expires in 4[12]m$/,
    );
  });
});

describe("isRunHosted (#110)", () => {
  it("is true exactly while the row carries hostedUntil", () => {
    expect(isRunHosted({})).toBe(false);
    expect(isRunHosted({ hostedUntil: undefined })).toBe(false);
    expect(isRunHosted({ hostedUntil: "2026-01-01T00:00:00.000Z" })).toBe(true);
  });
});

describe("hosting API clients (#110)", () => {
  it("stopRunHosting POSTs the stop endpoint", async () => {
    const fetcher = vi.fn(async () => ({}));
    await stopRunHosting("run/1", fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith("/api/runs/run%2F1/hosting/stop", { method: "POST" });
  });

  it("extendRunHosting POSTs minutes as JSON and returns the hosting view", async () => {
    const hosting = { until: "2026-01-01T01:00:00.000Z", ports: [], extendable: true };
    const fetcher = vi.fn(async () => ({ hosting }));
    const view = await extendRunHosting("run-1", 30, fetcher as unknown as typeof fetch);
    expect(view).toEqual(hosting);
    expect(fetcher).toHaveBeenCalledWith("/api/runs/run-1/hosting/extend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes: 30 }),
    });
  });
});
