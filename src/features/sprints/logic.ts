// Relative imports keep this module loadable by the plain-Node unit tests.
import { ProjectError } from "../projects/errors";
import { isIsoDate, isProjectPriority, isUuid } from "../projects/validation";
import { isWorkItemStatus, isWorkItemType } from "../work-items/validation";
import {
  SPRINT_STATUSES,
  type CapacityRow,
  type CapacityState,
  type Sprint,
  type SprintDetail,
  type SprintFieldErrors,
  type SprintFieldValues,
  type SprintItem,
  type SprintStatus,
} from "./types";

/*
 * Pure sprint logic: row parsing, form validation, capacity and lifecycle
 * gates. The database enforces every rule again (constraints, triggers, RPCs).
 */

export const NAME_MAX = 80;
export const GOAL_MAX = 2000;
export const CAPACITY_MAX = 10_000;
export const HISTORY_PAGE_SIZE = 10;

export function isSprintStatus(value: unknown): value is SprintStatus {
  return typeof value === "string" && (SPRINT_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProjectError("unexpected");
  return value as Row;
}
function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value) throw new ProjectError("unexpected");
  return value;
}
function nullableStr(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ProjectError("unexpected");
  return value;
}
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) throw new ProjectError("unexpected");
  return parsed;
}
function count(value: unknown): number {
  const parsed = nullableNumber(value);
  if (parsed === null || !Number.isSafeInteger(parsed) || parsed < 0) throw new ProjectError("unexpected");
  return parsed;
}

export function toSprint(value: unknown): Sprint {
  const row = asRow(value);
  if (!isSprintStatus(row.status)) throw new ProjectError("unexpected");
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    goal: nullableStr(row, "goal"),
    status: row.status,
    startDate: nullableStr(row, "start_date"),
    endDate: nullableStr(row, "end_date"),
    capacity: nullableNumber(row.capacity_points),
    startedAt: nullableStr(row, "started_at"),
    completedAt: nullableStr(row, "completed_at"),
    cancelledAt: nullableStr(row, "cancelled_at"),
    createdAt: str(row, "created_at"),
    itemCount: count(row.item_count),
    doneCount: count(row.done_count),
    estimateTotal: nullableNumber(row.estimate_total) ?? 0,
    doneEstimate: nullableNumber(row.done_estimate) ?? 0,
    unestimatedCount: count(row.unestimated_count),
  };
}

export function toSprintDetail(value: unknown): SprintDetail {
  const row = asRow(value);
  return { ...toSprint(row), projectId: str(row, "project_id"), createdByName: nullableStr(row, "created_by_name") };
}

export function toSprintItem(value: unknown): SprintItem {
  const row = asRow(value);
  const { type, status, priority } = row;
  if (!isWorkItemType(type) || !isWorkItemStatus(status) || !isProjectPriority(priority)) throw new ProjectError("unexpected");
  return {
    id: str(row, "id"),
    issueKey: str(row, "issue_key"),
    type,
    title: str(row, "title"),
    status,
    priority,
    assigneeId: nullableStr(row, "assignee_id"),
    assigneeName: nullableStr(row, "assignee_name"),
    estimate: nullableNumber(row.estimate),
    archivedAt: nullableStr(row, "archived_at"),
  };
}

export function toCapacityRow(value: unknown): CapacityRow {
  const row = asRow(value);
  return {
    assigneeId: nullableStr(row, "assignee_id"),
    assigneeName: nullableStr(row, "assignee_name"),
    itemCount: count(row.item_count),
    estimate: nullableNumber(row.estimate_total) ?? 0,
    unestimated: count(row.unestimated_count),
  };
}

export function rowsTotal(rows: readonly unknown[]): number {
  return rows.length === 0 ? 0 : count(asRow(rows[0]).total_count);
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function validateSprintFields(input: Record<string, unknown>, options: { requireDates: boolean }):
  { ok: true; values: SprintFieldValues } | { ok: false; errors: SprintFieldErrors } {
  const errors: SprintFieldErrors = {};
  const name = text(input.name);
  if (!name) errors.name = "Sprint name is required.";
  else if (name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) errors.name = `Use up to ${NAME_MAX} characters without line breaks.`;
  const goal = text(input.goal);
  if (goal.length > GOAL_MAX) errors.goal = `Keep the goal under ${GOAL_MAX.toLocaleString("en-US")} characters.`;
  const startDate = text(input.startDate);
  const endDate = text(input.endDate);
  if (startDate && !isIsoDate(startDate)) errors.startDate = "Enter a valid date.";
  if (endDate && !isIsoDate(endDate)) errors.endDate = "Enter a valid date.";
  if (options.requireDates && !startDate) errors.startDate = "An active sprint needs a start date.";
  if (options.requireDates && !endDate) errors.endDate = "An active sprint needs an end date.";
  if (!errors.startDate && !errors.endDate && startDate && endDate && startDate >= endDate) errors.endDate = "End date must be after the start date.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, values: { name, goal: goal || null, startDate: startDate || null, endDate: endDate || null } };
}

/** "" clears the capacity; otherwise 0–10,000 with at most one decimal. */
export function parseCapacity(value: unknown): number | null | "invalid" {
  const raw = text(value);
  if (!raw) return null;
  if (!/^\d{1,5}(\.\d)?$/.test(raw)) return "invalid";
  const parsed = Number(raw);
  return parsed > CAPACITY_MAX ? "invalid" : parsed;
}

// ---------------------------------------------------------------------------
// Capacity, dates and lifecycle gates
// ---------------------------------------------------------------------------

export function capacityState(planned: number, capacity: number | null): CapacityState {
  if (capacity === null) return { kind: "unset", planned };
  const ratio = capacity === 0 ? (planned > 0 ? Infinity : 0) : planned / capacity;
  return planned > capacity
    ? { kind: "over", planned, capacity, ratio, overBy: Math.round((planned - capacity) * 10) / 10 }
    : { kind: "within", planned, capacity, ratio };
}

const DAY = 86_400_000;

/** Calendar days from start to end (YYYY-MM-DD, end exclusive of nothing: 1 Jan → 14 Jan = 13 days). */
export function sprintDurationDays(startDate: string | null, endDate: string | null): number | null {
  if (!startDate || !endDate || !isIsoDate(startDate) || !isIsoDate(endDate)) return null;
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY);
}

/** Why a planned sprint cannot start yet (null = it can). Mirrors private.start_sprint. */
export function startBlocker(sprint: Pick<Sprint, "status" | "startDate" | "endDate" | "itemCount">, hasActiveSprint: boolean): string | null {
  if (sprint.status !== "PLANNING") return "Only planned sprints can start.";
  if (!sprint.startDate || !sprint.endDate) return "Set a start and end date first.";
  if (sprint.startDate >= sprint.endDate) return "The start date must be before the end date.";
  if (sprint.itemCount === 0) return "Add at least one work item first.";
  if (hasActiveSprint) return "Complete the active sprint first.";
  return null;
}

export function isOpenSprint(status: SprintStatus): boolean {
  return status === "PLANNING" || status === "ACTIVE";
}

export function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Item ids from a form/selection: 1..100 distinct UUIDs, else null. */
export function parseSelection(ids: unknown): string[] | null {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || !ids.every(isUuid)) return null;
  return new Set(ids).size === ids.length ? (ids as string[]).map((id) => id.toLowerCase()) : null;
}
