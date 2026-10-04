import { describe, expect, it } from "vitest";
import {
  humanizeCron,
  isValidTimezone,
  nextCronRunMs,
  nextCronRuns,
  parseCron,
  wallClockToUtc,
} from "./cron.js";

/**
 * Cron parser / next-run / humanizer tests (#121): strict validation,
 * Vixie dom/dow OR semantics, timezone math via Intl (half-hour offsets,
 * DST spring-forward gaps) and readable humanizations.
 */

const T = (iso: string): number => Date.parse(iso);

describe("parseCron (strict 5-field)", () => {
  it("accepts the canonical shapes: *, lists, ranges, steps, names", () => {
    for (const expr of [
      "* * * * *",
      "*/15 * * * *",
      "0 9 * * 1-5",
      "30 2 1,15 * *",
      "0 0 1 1 *",
      "0 12 * * 0",
      "0 12 * * 7",
      "59 23 31 12 sat",
      "0 0 * JAN-DEC SUN,SAT",
      "5,35 */6 1 3 mon",
    ]) {
      const parsed = parseCron(expr);
      expect(parsed.ok, expr).toBe(true);
    }
  });

  it("rejects non-5-field expressions", () => {
    expect(parseCron("* * * *").ok).toBe(false);
    expect(parseCron("* * * * * *").ok).toBe(false);
    expect(parseCron("").ok).toBe(false);
    expect(parseCron("@daily").ok).toBe(false);
  });

  it("rejects out-of-bounds and malformed values with field-attributed errors", () => {
    const errorOf = (expr: string): string => {
      const parsed = parseCron(expr);
      expect(parsed.ok).toBe(false);
      return parsed.ok ? "" : parsed.error;
    };
    expect(errorOf("60 * * * *")).toContain("minute");
    expect(errorOf("* 24 * * *")).toContain("hour");
    expect(errorOf("* * 0 * *")).toContain("day of month");
    expect(errorOf("* * 32 * *")).toContain("day of month");
    expect(errorOf("* * * 13 *")).toContain("month");
    expect(errorOf("* * * * 8")).toContain("day of week");
    expect(errorOf("5-2 * * * *")).toContain("inverted");
    expect(errorOf("*/0 * * * *")).toContain("step");
    expect(errorOf("a * * * *")).toContain("minute");
    expect(errorOf("* * ? * *")).toContain("day of month");
    expect(errorOf("* * L * *")).toContain("day of month");
    expect(errorOf("1, * * * *")).toContain("minute");
    expect(errorOf("* * 1, * *")).toContain("day of month");
  });

  it("normalizes dow 7 to Sunday and dedupes", () => {
    const parsed = parseCron("0 12 * * 0,7");
    expect(parsed.ok && parsed.value.dow).toEqual([0]);
  });

  it("tracks dom/dow restriction for the Vixie OR rule", () => {
    const both = parseCron("0 0 1 * 1");
    expect(both.ok && both.value.domRestricted).toBe(true);
    expect(both.ok && both.value.dowRestricted).toBe(true);
    const one = parseCron("0 0 1 * *");
    expect(one.ok && one.value.dowRestricted).toBe(false);
    const star = parseCron("* * * * *");
    expect(star.ok && star.value.domRestricted).toBe(false);
  });
});

describe("nextCronRunMs (timezone math via Intl)", () => {
  it("fires on the correct minute in UTC", () => {
    const parsed = parseCron("30 * * * *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(nextCronRunMs(parsed.value, T("2026-01-01T10:00:00Z"), "UTC")).toBe(
      T("2026-01-01T10:30:00Z"),
    );
    expect(nextCronRunMs(parsed.value, T("2026-01-01T10:30:00Z"), "UTC")).toBe(
      T("2026-01-01T11:30:00Z"),
    );
  });

  it("respects the schedule timezone's wall clock (half-hour offset, Asia/Kolkata)", () => {
    // 09:30 IST == 04:00 UTC (UTC+5:30).
    const parsed = parseCron("30 9 * * *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(nextCronRunMs(parsed.value, T("2026-06-01T03:00:00Z"), "Asia/Kolkata")).toBe(
      T("2026-06-01T04:00:00Z"),
    );
  });

  it("skips the nonexistent spring-forward wall time (America/New_York)", () => {
    // US DST 2026: clocks jump 02:00 → 03:00 on 2026-03-08. A 02:30 slot
    // does not exist that day; starting after Mar 7's 02:30 the next fire
    // is Mar 9 02:30 EDT.
    const parsed = parseCron("30 2 * * *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const next = nextCronRunMs(parsed.value, T("2026-03-08T00:00:00Z"), "America/New_York");
    expect(next).not.toBeNull();
    expect(new Date(next as number).toISOString()).toBe("2026-03-09T06:30:00.000Z");
  });

  it("still fires the day BEFORE the gap (02:30 EST on Mar 7 exists)", () => {
    const parsed = parseCron("30 2 * * *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const next = nextCronRunMs(parsed.value, T("2026-03-07T00:00:00Z"), "America/New_York");
    expect(new Date(next as number).toISOString()).toBe("2026-03-07T07:30:00.000Z");
  });

  it("picks the earlier instant when fall-back makes a wall time ambiguous", () => {
    // US fall-back 2026-11-01: 01:30 occurs twice (EDT then EST). We
    // resolve to the FIRST occurrence (05:30Z).
    const parsed = parseCron("30 1 * * *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const next = nextCronRunMs(parsed.value, T("2026-11-01T00:00:00Z"), "America/New_York");
    expect(new Date(next as number).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("applies the Vixie dom/dow OR rule when both fields are restricted", () => {
    // "0 0 13 * 5" = midnight on the 13th OR any Friday.
    const parsed = parseCron("0 0 13 * 5");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 2026-01-01 is a Thursday; first fire is Fri 2026-01-02 (dow match).
    expect(
      new Date(
        nextCronRunMs(parsed.value, T("2026-01-01T00:00:00Z"), "UTC") as number,
      ).toISOString(),
    ).toBe("2026-01-02T00:00:00.000Z");
    // And the 13th (a Tuesday) also fires via dom.
    expect(
      new Date(
        nextCronRunMs(parsed.value, T("2026-01-11T00:00:00Z"), "UTC") as number,
      ).toISOString(),
    ).toBe("2026-01-13T00:00:00.000Z");
  });

  it("scans across months for rare slots (Feb 29)", () => {
    const parsed = parseCron("30 2 29 2 *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const next = nextCronRunMs(parsed.value, T("2026-03-01T00:00:00Z"), "UTC");
    expect(new Date(next as number).toISOString()).toBe("2028-02-29T02:30:00.000Z");
  });

  it("handles month names and dow lists", () => {
    const parsed = parseCron("0 9 * MAR,JUN MON");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 2026-03-02 is the first Monday of March 2026.
    expect(
      new Date(
        nextCronRunMs(parsed.value, T("2026-02-01T00:00:00Z"), "UTC") as number,
      ).toISOString(),
    ).toBe("2026-03-02T09:00:00.000Z");
  });
});

describe("nextCronRuns (client preview)", () => {
  it("lists the next runs strictly after the from instant", () => {
    expect(
      nextCronRuns("*/15 * * * *", { from: "2026-01-01T10:05:00Z", timeZone: "UTC", count: 3 }),
    ).toEqual(["2026-01-01T10:15:00.000Z", "2026-01-01T10:30:00.000Z", "2026-01-01T10:45:00.000Z"]);
  });

  it("returns [] for invalid expressions instead of throwing", () => {
    expect(nextCronRuns("not cron", { timeZone: "UTC" })).toEqual([]);
    expect(nextCronRuns("* * * * *", { timeZone: "Not/AZone" })).toEqual([]);
  });
});

describe("isValidTimezone", () => {
  it("accepts IANA zones and rejects junk", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidTimezone("not a zone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});

describe("wallClockToUtc", () => {
  it("round-trips a wall time and returns null inside a DST gap", () => {
    expect(wallClockToUtc(2026, 3, 8, 2, 30, "America/New_York")).toBeNull();
    expect(wallClockToUtc(2026, 3, 8, 3, 30, "America/New_York")).toBe(T("2026-03-08T07:30:00Z"));
  });
});

describe("humanizeCron", () => {
  it("humanizes the common shapes", () => {
    expect(humanizeCron("* * * * *")).toBe("Every minute");
    expect(humanizeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(humanizeCron("0 */2 * * *")).toBe("Every 2 hours");
    expect(humanizeCron("30 */6 * * *")).toBe("Every 6 hours at :30");
    expect(humanizeCron("30 9 * * *")).toBe("Every day at 09:30");
    expect(humanizeCron("30 9 * * 1-5")).toBe(
      "Monday, Tuesday, Wednesday, Thursday and Friday at 09:30",
    );
    expect(humanizeCron("0 9 1 * *")).toBe("On day 1 of every month at 09:00");
    expect(humanizeCron("0 9 1 1 *")).toBe("On day 1 of every month in January at 09:00");
    expect(humanizeCron("0,30 9 * * *")).toBe("Every day at 09:00 and 09:30");
    expect(humanizeCron("0,30 */6 * * *")).toBe(
      "Every day at 00:00, 00:30, 06:00, 06:30, 12:00, 12:30, 18:00 and 18:30",
    );
    expect(humanizeCron("0 0 13 * 5")).toBe("On day 13 or on Friday at 00:00");
    expect(humanizeCron("* * * * 0")).toBe("Every minute on Sunday");
    expect(humanizeCron("*/5 * * * 0")).toBe("Every 5 minutes on Sunday");
  });

  it("names the parse error for invalid expressions", () => {
    expect(humanizeCron("99 * * * *")).toMatch(/^Invalid schedule: /);
  });
});
