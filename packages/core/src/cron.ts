import { z } from "zod";
import { timestampSchema } from "./common.js";

/**
 * Dependency-free 5-field cron support (#121): a strict parser, a
 * timezone-aware next-run computation (wall-clock matching via
 * `Intl.DateTimeFormat`, DST gaps skipped like Vixie cron) and a small
 * humanizer. Shared by the daemon scheduler and the web editor preview.
 *
 * Semantics (deliberately Vixie-flavored, kept small):
 * - Exactly 5 fields: minute hour day-of-month month day-of-week.
 * - Each field: `*`, a list (`a,b`), a range (`a-b`), steps (`x/n`,
 *   `a-b/n`); month/day names (`JAN`..`DEC`, `SUN`..`SAT`) allowed where
 *   POSIX allows them. `7` is Sunday alongside `0`.
 * - dom/dow: when BOTH are restricted, a day matches if EITHER matches
 *   (the classic cron OR rule); otherwise both must match.
 * - Timezone: fields are wall-clock in the configured IANA zone; wall
 *   times that do not exist (spring-forward gap) never fire — the next
 *   matching instant is used instead.
 */

export const CRON_FIELD_COUNT = 5;

interface FieldBounds {
  min: number;
  max: number;
  name: string;
}

/** Field bounds: min, max (inclusive) and the canonical name for messages. */
const FIELD_BOUNDS: readonly FieldBounds[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day of month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day of week" },
];

/** Bounds of one field (undefined only past the validated field count). */
function fieldBounds(index: number): FieldBounds {
  const bounds = FIELD_BOUNDS[index];
  if (bounds === undefined) throw new Error(`invalid cron field index ${index}`);
  return bounds;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** Parsed cron expression: sorted value sets per field + restriction flags. */
export interface ParsedCron {
  readonly minute: readonly number[];
  readonly hour: readonly number[];
  readonly dom: readonly number[];
  readonly month: readonly number[];
  readonly dow: readonly number[];
  /** True when the dom field is anything but `*` (Vixie OR rule). */
  readonly domRestricted: boolean;
  /** True when the dow field is anything but `*` (Vixie OR rule). */
  readonly dowRestricted: boolean;
}

export type ParseCronResult = { ok: true; value: ParsedCron } | { ok: false; error: string };

/** Parses one number or name (`JAN`, `SUN`) into its field value. */
function parseAtom(atom: string, field: number, allowNames: boolean): number | undefined {
  if (/^\d{1,2}$/.test(atom)) return Number(atom);
  if (!allowNames) return undefined;
  const name = atom.toLowerCase();
  if (field === 3) return MONTH_NAMES[name];
  if (field === 4) return DOW_NAMES[name];
  return undefined;
}

/** Splits `item` on its FIRST separator; the tail is undefined when absent. */
function splitFirst(item: string, separator: string): [string] | [string, string] {
  const at = item.indexOf(separator);
  return at === -1 ? [item] : [item.slice(0, at), item.slice(at + separator.length)];
}

/**
 * Strictly parses a 5-field cron expression. Rejects everything the tiny
 * matcher does not understand (`?`, `L`, `W`, `#`, `@macros`, empty or
 * out-of-range values, inverted ranges, zero steps) with a field-attributed
 * message — the API surfaces it verbatim in the 422.
 */
export function parseCron(expression: string): ParseCronResult {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) {
    return {
      ok: false,
      error: `cron must have exactly ${CRON_FIELD_COUNT} fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    };
  }
  const sets: number[][] = [];
  let domRestricted = false;
  let dowRestricted = false;
  for (let field = 0; field < CRON_FIELD_COUNT; field++) {
    const { min, max, name } = fieldBounds(field);
    // POSIX: dow `7` is Sunday alongside `0` — ranges may end on it.
    const upper = field === 4 ? max + 1 : max;
    const allowNames = field === 3 || field === 4;
    const raw = fields[field];
    if (raw === undefined) {
      return { ok: false, error: `cron field ${field + 1} is missing` };
    }
    if (field === 2 && raw !== "*") domRestricted = true;
    if (field === 4 && raw !== "*") dowRestricted = true;
    const values = new Set<number>();
    for (const item of raw.split(",")) {
      if (item.length === 0) {
        return { ok: false, error: `cron ${name} field has an empty list item` };
      }
      const [rangePart, stepPart] = splitFirst(item, "/");
      if (rangePart === undefined) {
        return { ok: false, error: `cron ${name} field has an empty list item` };
      }
      const step = stepPart === undefined ? 1 : Number(stepPart);
      if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || step < 1)) {
        return { ok: false, error: `cron ${name} field has an invalid step "/${stepPart}"` };
      }
      let low: number;
      let high: number;
      if (rangePart === "*") {
        low = min;
        high = max;
      } else if (rangePart.includes("-")) {
        const [startAtom, endAtom] = splitFirst(rangePart, "-");
        if (startAtom === undefined || endAtom === undefined) {
          return { ok: false, error: `cron ${name} field has a malformed range "${rangePart}"` };
        }
        const start = parseAtom(startAtom, field, allowNames);
        const end = parseAtom(endAtom, field, allowNames);
        if (start === undefined || end === undefined) {
          return { ok: false, error: `cron ${name} field has a malformed range "${rangePart}"` };
        }
        low = start;
        high = end;
      } else {
        const atom = parseAtom(rangePart, field, allowNames);
        if (atom === undefined) {
          return { ok: false, error: `cron ${name} field has an invalid value "${rangePart}"` };
        }
        low = atom;
        high = stepPart === undefined ? atom : max;
      }
      if (low < min || high > upper || low > high) {
        return {
          ok: false,
          error: `cron ${name} field range ${low}-${high} is out of bounds (${min}-${max}) or inverted`,
        };
      }
      for (let value = low; value <= high; value += step) {
        values.add(field === 4 && value === 7 ? 0 : value);
      }
    }
    if (values.size === 0) {
      return { ok: false, error: `cron ${name} field matches no value` };
    }
    sets.push([...values].sort((a, b) => a - b));
  }
  return {
    ok: true,
    value: {
      minute: sets[0] ?? [],
      hour: sets[1] ?? [],
      dom: sets[2] ?? [],
      month: sets[3] ?? [],
      dow: sets[4] ?? [],
      domRestricted,
      dowRestricted,
    },
  };
}

/** Wall-clock fields of an instant in a timezone, via Intl (cached formatters). */
export interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0=Sunday..6=Saturday. */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Formatter cache, keyed by timezone. `Intl.DateTimeFormat` construction is
 * the expensive part of wall-clock matching; one entry per zone the process
 * ever sees (a handful) is plenty.
 * ponytail: unbounded per-zone cache; LRU if a process ever cycles zones.
 */
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      // hour12 wins over hourCycle in options resolution — set BOTH so
      // hours render as 00..23 (a PM "10" for 22:30 would corrupt parsing).
      hour12: false,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock parts of `ms` in `timeZone` (throws on an invalid zone). */
export function wallClockParts(ms: number, timeZone: string): WallClockParts {
  const parts = partsFormatter(timeZone).formatToParts(ms);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let weekday = -1;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value) % 24;
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "weekday":
        weekday = WEEKDAYS.indexOf(part.value.slice(0, 3));
        break;
    }
  }
  return { year, month, day, hour, minute, weekday: Math.max(0, weekday) };
}

/**
 * The earliest instant whose wall clock in `timeZone` reads exactly
 * `y-m-d h:min` — or null when that wall time does not exist (DST
 * spring-forward gap). Up to two offset corrections + one verifying round
 * (oscillation past that means the wall time does not exist).
 */
export function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let round = 0; round < 3; round++) {
    const parts = wallClockParts(guess, timeZone);
    const delta =
      target - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    if (delta === 0) return guess;
    guess += delta;
  }
  return null;
}

/** Upper bound of the day scan: covers the rarest legal pattern (Feb 29). */
const MAX_SCAN_DAYS = 366 * 8;

/**
 * The next matching instant STRICTLY AFTER `afterMs`, in ms. Day-level scan
 * (month/dom/dow) then hour×minute enumeration inside the matched day —
 * bounded, dependency-free, and DST-correct (gap wall times return null and
 * are skipped). Returns null only past the 8-year scan bound (Feb 29-only
 * expressions still match inside it).
 */
export function nextCronRunMs(
  parsed: ParsedCron,
  afterMs: number,
  timeZone: string,
): number | null {
  let candidate = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  for (let scanned = 0; scanned < MAX_SCAN_DAYS; scanned++) {
    const parts = wallClockParts(candidate, timeZone);
    // Date-level gate (month + dom/dow with the Vixie OR rule): the jump to
    // the next day must not consider the candidate's time of day.
    const domMatch = parsed.dom.includes(parts.day);
    const dowMatch = parsed.dow.includes(parts.weekday);
    const dayMatches =
      parsed.domRestricted && parsed.dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
    if (!parsed.month.includes(parts.month) || !dayMatches) {
      candidate += 24 * 3_600_000;
      continue;
    }
    for (const hour of parsed.hour) {
      for (const minute of parsed.minute) {
        const t = wallClockToUtc(parts.year, parts.month, parts.day, hour, minute, timeZone);
        if (t === null) continue;
        if (t > afterMs) return t;
      }
    }
    candidate += 24 * 3_600_000;
  }
  return null;
}

/** `nextCronRunMs` for an unparsed expression; invalid input → null. */
export function nextCronRun(expression: string, afterMs: number, timeZone: string): number | null {
  const parsed = parseCron(expression);
  return parsed.ok ? nextCronRunMs(parsed.value, afterMs, timeZone) : null;
}

/**
 * The next `count` runs strictly after `fromIso` (default now), as ISO
 * timestamps — the editor's upcoming-run preview. Invalid expressions and
 * invalid zones yield an empty list.
 */
export function nextCronRuns(
  expression: string,
  options: { from?: string; timeZone: string; count?: number } = { timeZone: "UTC" },
): string[] {
  const { from, timeZone, count = 5 } = options;
  const parsed = parseCron(expression);
  if (!parsed.ok || !isValidTimezone(timeZone)) return [];
  const out: string[] = [];
  let cursor = Date.parse(from ?? new Date().toISOString());
  if (!Number.isFinite(cursor)) return [];
  for (let index = 0; index < count; index++) {
    const next = nextCronRunMs(parsed.value, cursor, timeZone);
    if (next === null) break;
    out.push(new Date(next).toISOString());
    cursor = next;
  }
  return out;
}

/** True when `timeZone` is a valid IANA name `Intl` accepts. */
export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Humanizer
//

const DOW_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "a", "a and b", "a, b and c" over any scalar values. */
function listValues(values: readonly (string | number)[], labels?: readonly string[]): string {
  const rendered = values.map((value) =>
    typeof value === "number" ? (labels?.[value] ?? String(value)) : value,
  );
  if (rendered.length === 0) return "";
  if (rendered.length === 1) return rendered[0] ?? "";
  return `${rendered.slice(0, -1).join(", ")} and ${rendered[rendered.length - 1]}`;
}

/** "at 09:00 and 09:30" — every hour×minute combination, wall-clock order. */
function atTime(hours: readonly number[], minutes: readonly number[]): string {
  const times: string[] = [];
  for (const hour of hours) {
    for (const minute of minutes) {
      times.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    }
  }
  return listValues(times);
}

const isFullRange = (values: readonly number[], min: number, max: number): boolean =>
  values.length === max - min + 1 && values[0] === min && values[values.length - 1] === max;

/**
 * The step of an every-N pattern (a star-step over the full range): the
 * values start at `min` and tile the range exactly. null when the set is
 * anything else (a partial list, a single value, an uneven stride).
 */
function stepOf(values: readonly number[], min: number, max: number): number | null {
  if (values.length < 2 || values[0] !== min) return null;
  const first = values[0];
  const second = values[1];
  const last = values[values.length - 1];
  if (first === undefined || second === undefined || last === undefined) return null;
  const step = second - first;
  if (step <= 1) return null;
  for (let index = 1; index < values.length; index++) {
    if ((values[index] ?? 0) - (values[index - 1] ?? 0) !== step) return null;
  }
  return last + step > max ? step : null;
}

/**
 * Humanizes a strict 5-field cron expression ("Mondays at 09:30"). Invalid
 * expressions return a fallback string naming the parse error so the editor
 * can render it inline.
 */
export function humanizeCron(expression: string): string {
  const parsed = parseCron(expression);
  if (!parsed.ok) return `Invalid schedule: ${parsed.error}`;

  const { minute, hour, dom, month, dow } = parsed.value;
  const everyMinute = isFullRange(minute, 0, 59);
  const everyHour = isFullRange(hour, 0, 23);
  const everyDom = isFullRange(dom, 1, 31);
  const everyMonth = isFullRange(month, 1, 12);
  const everyDow = isFullRange(dow, 0, 6);

  if (everyMinute && everyHour && everyDom && everyMonth && everyDow) return "Every minute";

  const minuteStep = stepOf(minute, 0, 59);
  if (minuteStep !== null && everyHour && everyDom && everyMonth && everyDow) {
    return `Every ${minuteStep} minutes`;
  }
  const hourStep = stepOf(hour, 0, 23);
  if (hourStep !== null && everyDom && everyMonth && everyDow) {
    return minute.length === 1 && minute[0] === 0
      ? `Every ${hourStep} hours`
      : `Every ${hourStep} hours at :${String(minute[0]).padStart(2, "0")}`;
  }

  const timePhrase = `at ${atTime(hour, minute)}`;
  const monthPhrase = everyMonth
    ? ""
    : ` in ${listValues(
        month.map((value) => value - 1),
        MONTH_LABELS,
      )}`;

  if (everyDom && everyDow) return `Every day${monthPhrase} ${timePhrase}`.replace("  ", " ");
  if (everyDom && !everyDow) {
    return `${listValues(dow, DOW_LABELS)}${monthPhrase} ${timePhrase}`.replace("  ", " ");
  }
  if (everyDow && !everyDom) {
    return `On day ${listValues(dom)} of every month${monthPhrase} ${timePhrase}`.replace(
      "  ",
      " ",
    );
  }
  return `On day ${listValues(dom)}${monthPhrase} ${timePhrase}`.replace("  ", " ");
}

// ---------------------------------------------------------------------------
// Schedule config schema (stored per workflow, #121)
//

export const SCHEDULE_TASK_TEMPLATE_MAX = 20_000;

/**
 * A workflow schedule config (#121): `{enabled, cron, taskTemplate,
 * timezone}`. `cron` is strictly 5-field; `timezone` must be a valid IANA
 * zone (`Intl`-checked). The daemon evaluates the cron in that timezone's
 * wall clock and queues a run of the workflow's latest revision with the
 * task taken from `taskTemplate` (plain text — prompt-template variables
 * belong to node prompts, not the task).
 */
export const WorkflowScheduleConfigSchema = z.strictObject({
  enabled: z.boolean(),
  cron: z.string().refine((value) => parseCron(value).ok, {
    message: "cron must be a valid 5-field expression (minute hour day-of-month month day-of-week)",
  }),
  taskTemplate: z
    .string()
    .min(1, "taskTemplate must be a non-empty string")
    .max(
      SCHEDULE_TASK_TEMPLATE_MAX,
      `taskTemplate must be at most ${SCHEDULE_TASK_TEMPLATE_MAX} characters`,
    ),
  timezone: z.string().refine((value) => value.length > 0 && isValidTimezone(value), {
    message: "timezone must be a valid IANA timezone (e.g. America/New_York)",
  }),
});

export type WorkflowScheduleConfig = z.infer<typeof WorkflowScheduleConfigSchema>;

/** A stored workflow schedule row as the API serves it. */
export interface WorkflowSchedule {
  id: string;
  workflowId: string;
  enabled: boolean;
  cron: string;
  taskTemplate: string;
  timezone: string;
  /** ISO minute of the last scheduled slot the daemon handled (fired or skipped). */
  lastFiredAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** List projection of a schedule for workflow rows (badge + drawer link). */
export interface WorkflowScheduleSummary {
  enabled: boolean;
  cron: string;
  timezone: string;
  lastFiredAt?: string;
}

export const WorkflowScheduleSchema = z.strictObject({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  enabled: z.boolean(),
  cron: z.string().min(1),
  taskTemplate: z.string().min(1),
  timezone: z.string().min(1),
  lastFiredAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
