// Relative imports keep this module loadable by the plain-Node unit tests.
import { ProjectError } from "../projects/errors";
import { isIsoDate } from "../projects/validation";

/*
 * Burndown model. Actual values come only from private.sprint_burndown, which
 * replays the database-backed sprint history (baseline at start, then every
 * status/estimate/membership change). Nothing here invents a value:
 *   - a day the database has no history for (has_data = false) is a gap,
 *     never zero;
 *   - days after today (or after completion) have no actual value at all.
 * The ideal line is a reference: the baseline scope (first day with data)
 * burned evenly over the working days (Mon–Fri) after the start date, flat
 * across weekends. A sprint with no working days burns over calendar days.
 * Dates are UTC calendar days, matching the database.
 */

/** A recorded day carries numbers; a day without history carries none (never zeros). */
export type BurndownDay =
  | { day: string; hasData: true; scopePoints: number; completedPoints: number; remainingPoints: number; remainingItems: number; unestimatedItems: number }
  | { day: string; hasData: false };

export type BurndownPoint = {
  day: string;
  weekend: boolean;
  ideal: number | null;
  /** null = no data (gap) or not yet happened. */
  actual: number | null;
  status: "data" | "missing" | "future";
  scope: number | null;
  completed: number | null;
  remainingItems: number | null;
  unestimatedItems: number | null;
};

export type Burndown = {
  points: BurndownPoint[];
  baselineScope: number | null;
  /** Latest day with data. */
  latest: BurndownPoint | null;
  missingDays: number;
  scopeChanged: boolean;
};

const DAY = 86_400_000;

type Row = Record<string, unknown>;

function num(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) throw new ProjectError("unexpected");
  return parsed;
}

export function toBurndownDay(value: unknown): BurndownDay {
  if (typeof value !== "object" || value === null) throw new ProjectError("unexpected");
  const row = value as Row;
  if (typeof row.day !== "string" || !isIsoDate(row.day) || typeof row.has_data !== "boolean") throw new ProjectError("unexpected");
  if (!row.has_data) {
    // The database returns NULLs for days before any history exists.
    if ([row.scope_points, row.completed_points, row.remaining_points, row.remaining_items].some((value) => value !== null && value !== undefined)) throw new ProjectError("unexpected");
    return { day: row.day, hasData: false };
  }
  return {
    day: row.day,
    hasData: true,
    scopePoints: num(row.scope_points),
    completedPoints: num(row.completed_points),
    remainingPoints: num(row.remaining_points),
    remainingItems: num(row.remaining_items),
    unestimatedItems: num(row.unestimated_items),
  };
}

export function isWeekend(day: string): boolean {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/** Every calendar day from start to end inclusive (YYYY-MM-DD, UTC). Capped at 366. */
export function sprintDays(startDate: string, endDate: string): string[] {
  if (!isIsoDate(startDate) || !isIsoDate(endDate) || startDate > endDate) return [];
  const days: string[] = [];
  for (let t = Date.parse(`${startDate}T00:00:00Z`), end = Date.parse(`${endDate}T00:00:00Z`); t <= end && days.length < 366; t += DAY) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Ideal remaining at the end of each day: scope × (burn days still ahead) / (burn days).
 * Burn days are the working days after the start; day one starts at full scope.
 */
export function idealLine(days: readonly string[], scope: number): number[] {
  if (days.length === 0) return [];
  const rest = days.slice(1);
  let burn = rest.map((day) => !isWeekend(day));
  if (!burn.some(Boolean)) burn = rest.map(() => true);
  const total = burn.filter(Boolean).length;
  if (total === 0) return days.map(() => scope);
  let left = total;
  const values = [scope];
  burn.forEach((burns) => {
    if (burns) left -= 1;
    values.push(Math.round(((scope * left) / total) * 100) / 100);
  });
  return values;
}

export function buildBurndown(startDate: string | null, endDate: string | null, rows: readonly BurndownDay[]): Burndown {
  if (!startDate || !endDate) return { points: [], baselineScope: null, latest: null, missingDays: 0, scopeChanged: false };
  const days = sprintDays(startDate, endDate);
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const baseline = rows.find((row): row is Extract<BurndownDay, { hasData: true }> => row.hasData) ?? null;
  const ideal = baseline ? idealLine(days, baseline.scopePoints) : days.map(() => null);
  let latest: BurndownPoint | null = null;
  let missingDays = 0;
  const points = days.map((day, index): BurndownPoint => {
    const row = byDay.get(day);
    const base = { day, weekend: isWeekend(day), ideal: ideal[index] ?? null };
    if (!row) return { ...base, actual: null, status: "future", scope: null, completed: null, remainingItems: null, unestimatedItems: null };
    if (!row.hasData) {
      missingDays += 1;
      return { ...base, actual: null, status: "missing", scope: null, completed: null, remainingItems: null, unestimatedItems: null };
    }
    const point: BurndownPoint = {
      ...base, actual: row.remainingPoints, status: "data", scope: row.scopePoints, completed: row.completedPoints,
      remainingItems: row.remainingItems, unestimatedItems: row.unestimatedItems,
    };
    latest = point;
    return point;
  });
  const scopeChanged = baseline !== null && rows.some((row) => row.hasData && row.scopePoints !== baseline.scopePoints);
  return { points, baselineScope: baseline?.scopePoints ?? null, latest, missingDays, scopeChanged };
}
