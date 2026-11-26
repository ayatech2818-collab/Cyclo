// Relative imports keep this module loadable by the plain-Node unit tests.
import { ProjectError } from "../projects/errors";
import { isProjectPriority, isUuid, normalizeSearch } from "../projects/validation";
import { PRIORITY_LABELS } from "../projects/types";
import { TYPE_LABELS, WORK_STATUS_LABELS, type AssigneeFilter } from "../work-items/types";
import { isWorkItemStatus } from "../work-items/validation";
import {
  BACKLOG_GROUPS,
  BACKLOG_TYPES,
  type BacklogGroup,
  type BacklogItem,
  type BacklogQuery,
  type BacklogSummary,
  type BacklogType,
  type EpicFilter,
  type Placement,
} from "./types";

/*
 * Pure backlog logic: URL query, row parsing, grouping and drag placement.
 * The database enforces permissions and ordering; this only shapes the UI.
 */

export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;
const PAGE_MAX = 100_000;

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isBacklogType(value: unknown): value is BacklogType {
  return typeof value === "string" && (BACKLOG_TYPES as readonly string[]).includes(value);
}

export function isBacklogGroup(value: unknown): value is BacklogGroup {
  return typeof value === "string" && (BACKLOG_GROUPS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// URL query
// ---------------------------------------------------------------------------

export function parseBacklogQuery(params: SearchParams): BacklogQuery {
  const type = single(params.type);
  const status = single(params.status);
  const priority = single(params.priority);
  const assignee = single(params.assignee);
  const epic = single(params.epic);
  const group = single(params.group);
  const pageParam = single(params.page);
  const size = Number(single(params.size));
  let page = 1;
  if (pageParam && /^\d{1,6}$/.test(pageParam)) page = Math.min(Math.max(Number(pageParam), 1), PAGE_MAX);

  const assigneeFilter: AssigneeFilter = assignee === "none" ? { kind: "unassigned" } : assignee && isUuid(assignee) ? { kind: "person", id: assignee.toLowerCase() } : { kind: "any" };
  const epicFilter: EpicFilter = epic === "none" ? { kind: "none" } : epic && isUuid(epic) ? { kind: "epic", id: epic.toLowerCase() } : { kind: "any" };

  return {
    search: normalizeSearch(single(params.q)),
    type: isBacklogType(type) ? type : null,
    status: isWorkItemStatus(status) ? status : null,
    priority: isProjectPriority(priority) ? priority : null,
    assignee: assigneeFilter,
    epic: epicFilter,
    includeCompleted: single(params.completed) === "1",
    group: isBacklogGroup(group) ? group : "none",
    page,
    pageSize: (PAGE_SIZE_OPTIONS as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  };
}

export function backlogQueryToParams(query: BacklogQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search) params.set("q", query.search);
  if (query.type) params.set("type", query.type);
  if (query.status) params.set("status", query.status);
  if (query.priority) params.set("priority", query.priority);
  if (query.assignee.kind === "unassigned") params.set("assignee", "none");
  if (query.assignee.kind === "person") params.set("assignee", query.assignee.id);
  if (query.epic.kind === "none") params.set("epic", "none");
  if (query.epic.kind === "epic") params.set("epic", query.epic.id);
  if (query.includeCompleted) params.set("completed", "1");
  if (query.group !== "none") params.set("group", query.group);
  if (query.pageSize !== DEFAULT_PAGE_SIZE) params.set("size", String(query.pageSize));
  if (query.page > 1) params.set("page", String(query.page));
  return params;
}

export function backlogHref(projectId: string, query: BacklogQuery, overrides: Partial<BacklogQuery> = {}): string {
  const params = backlogQueryToParams({ ...query, ...overrides }).toString();
  return `/projects/${projectId}/backlog${params ? `?${params}` : ""}`;
}

export function hasBacklogFilters(query: BacklogQuery): boolean {
  return Boolean(query.search || query.type || query.status || query.priority || query.assignee.kind !== "any" || query.epic.kind !== "any");
}

export const CLEARED_FILTERS: Partial<BacklogQuery> = {
  search: "", type: null, status: null, priority: null, assignee: { kind: "any" }, epic: { kind: "any" }, page: 1,
};

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

export function toBacklogItem(value: unknown): BacklogItem {
  const row = asRow(value);
  const { type, status, priority } = row;
  if (!isBacklogType(type) || !isWorkItemStatus(status) || !isProjectPriority(priority)) throw new ProjectError("unexpected");
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
    epicId: nullableStr(row, "epic_id"),
    epicKey: nullableStr(row, "epic_key"),
    epicTitle: nullableStr(row, "epic_title"),
    subtaskCount: count(row.subtask_count),
  };
}

export function backlogTotal(rows: readonly unknown[]): number {
  return rows.length === 0 ? 0 : count(asRow(rows[0]).total_count);
}

/** Folds backlog_summary rows (dimension, key, label, item_count, estimate_total). */
export function toBacklogSummary(rows: readonly unknown[]): BacklogSummary {
  const summary: BacklogSummary = {
    total: 0, estimate: null, byStatus: {}, byType: {}, byPriority: {}, unassigned: 0, unestimated: 0, epics: [], withoutEpic: 0,
  };
  for (const value of rows) {
    const row = asRow(value);
    const dimension = str(row, "dimension");
    const key = str(row, "key");
    const items = count(row.item_count);
    const estimate = nullableNumber(row.estimate_total);
    switch (dimension) {
      case "total": summary.total = items; summary.estimate = estimate; break;
      case "status": if (isWorkItemStatus(key)) summary.byStatus[key] = items; break;
      case "type": if (isBacklogType(key)) summary.byType[key] = items; break;
      case "priority": if (isProjectPriority(key)) summary.byPriority[key] = items; break;
      case "assignee": summary.unassigned = items; break;
      case "estimate": summary.unestimated = items; break;
      case "epic":
        if (key === "none") summary.withoutEpic = items;
        else if (isUuid(key)) summary.epics.push({ id: key, label: nullableStr(row, "label") ?? "Epic", count: items, estimate });
        break;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Grouping and drag placement
// ---------------------------------------------------------------------------

export type BacklogSection = { key: string; label: string; items: BacklogItem[] };

function groupKey(item: BacklogItem, group: BacklogGroup): { key: string; label: string } {
  switch (group) {
    case "epic": return item.epicId ? { key: item.epicId, label: `${item.epicKey} · ${item.epicTitle}` } : { key: "none", label: "No epic" };
    case "type": return { key: item.type, label: TYPE_LABELS[item.type] };
    case "priority": return { key: item.priority, label: PRIORITY_LABELS[item.priority] };
    case "status": return { key: item.status, label: WORK_STATUS_LABELS[item.status] };
    default: return { key: "all", label: "Backlog" };
  }
}

/** Splits rank-ordered rows into contiguous sections (the database orders by group first). */
export function groupBacklog(items: readonly BacklogItem[], group: BacklogGroup): BacklogSection[] {
  const sections: BacklogSection[] = [];
  for (const item of items) {
    const { key, label } = groupKey(item, group);
    const last = sections[sections.length - 1];
    if (last && last.key === key) last.items.push(item);
    else sections.push({ key, label, items: [item] });
  }
  return sections;
}

/** Moves one element; returns a new array. */
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Neighbours of the moved item in its new position. The database places the
 * item right after `afterId` (or, at the top, right before `beforeId`).
 */
export function placementOf(ids: readonly string[], movedId: string): Placement | null {
  const index = ids.indexOf(movedId);
  if (index < 0 || ids.length < 2) return null;
  return { afterId: index > 0 ? ids[index - 1] : null, beforeId: index < ids.length - 1 ? ids[index + 1] : null };
}

/** Quick-create input: a trimmed one-line title and a Task/Bug type. */
export function validateQuickCreate(type: unknown, title: unknown): { ok: true; type: "TASK" | "BUG"; title: string } | { ok: false; error: string } {
  if (type !== "TASK" && type !== "BUG") return { ok: false, error: "Choose Task or Bug." };
  const text = typeof title === "string" ? title.trim() : "";
  if (!text) return { ok: false, error: "Enter a title." };
  if (text.length > 255 || /[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: "Use up to 255 characters without line breaks." };
  return { ok: true, type, title: text };
}

export type BulkChange = { priority: BacklogItem["priority"] | null; assignee: { set: false } | { set: true; id: string | null } };

/** Bulk form: "" = leave unchanged; assignee "none" = unassign. */
export function parseBulkChange(priority: unknown, assignee: unknown): BulkChange | null {
  const nextPriority = isProjectPriority(priority) ? priority : null;
  let nextAssignee: BulkChange["assignee"] = { set: false };
  if (assignee === "none") nextAssignee = { set: true, id: null };
  else if (isUuid(assignee)) nextAssignee = { set: true, id: assignee.toLowerCase() };
  if (!nextPriority && !nextAssignee.set) return null;
  return { priority: nextPriority, assignee: nextAssignee };
}

export function formatPoints(value: number | null): string {
  if (value === null) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
