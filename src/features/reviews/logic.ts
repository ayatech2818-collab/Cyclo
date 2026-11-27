// Relative imports keep this module loadable by the plain-Node unit tests.
import type { AppRole } from "../auth/access";
import { ProjectError } from "../projects/errors";
import type { ProjectPriority } from "../projects/types";
import { isProjectPriority, isUuid, normalizeSearch } from "../projects/validation";
import type { WorkItemType } from "../work-items/types";
import { isWorkItemType } from "../work-items/validation";

/*
 * Review Inbox (Phase 8G1): pure logic shared by the page, the server code and
 * the unit tests. The database (list_review_queue / review_queue_summary and
 * execute_work_item) decides scope and every decision again; these helpers
 * only parse untrusted input and shape rows.
 */

/** Roles that may open the inbox. Hiding the link is a convenience only. */
export const REVIEW_ROLES = ["SUPER_ADMIN", "PROJECT_MANAGER"] as const satisfies readonly AppRole[];

export function canUseReviewInbox(role: AppRole): boolean {
  return (REVIEW_ROLES as readonly AppRole[]).includes(role);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const REVIEW_SORTS = ["oldest", "newest", "priority"] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];
export const REVIEW_SORT_LABELS: Record<ReviewSort, string> = {
  oldest: "Oldest first",
  newest: "Newest first",
  priority: "Highest priority",
};

/** Minimum waiting time, in days (allow-listed; the database accepts 0–365). */
export const REVIEW_AGES = [1, 3, 7] as const;
export type ReviewAge = (typeof REVIEW_AGES)[number];
export const REVIEW_AGE_LABELS: Record<ReviewAge, string> = {
  1: "Waiting 1+ day",
  3: "Waiting 3+ days",
  7: "Waiting 7+ days",
};

export const REVIEW_PAGE_SIZE = 20;
const PAGE_MAX = 100_000;

export type ReviewAssigneeFilter = { kind: "any" } | { kind: "unassigned" } | { kind: "person"; id: string };

export type ReviewQuery = {
  search: string;
  projectId: string | null;
  assignee: ReviewAssigneeFilter;
  priority: ProjectPriority | null;
  minAgeDays: ReviewAge | null;
  sort: ReviewSort;
  page: number;
};

export const DEFAULT_REVIEW_QUERY: ReviewQuery = {
  search: "", projectId: null, assignee: { kind: "any" }, priority: null, minAgeDays: null, sort: "oldest", page: 1,
};

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parses untrusted URL params into a bounded query; invalid values fall back to defaults. */
export function parseReviewQuery(params: SearchParams): ReviewQuery {
  const project = single(params.project);
  const assignee = single(params.assignee);
  const priority = single(params.priority);
  const age = Number(single(params.age));
  const sort = single(params.sort);
  const pageParam = single(params.page);
  let page = 1;
  if (pageParam && /^\d{1,6}$/.test(pageParam)) page = Math.min(Math.max(Number(pageParam), 1), PAGE_MAX);
  return {
    search: normalizeSearch(single(params.q)),
    projectId: isUuid(project) ? project.toLowerCase() : null,
    assignee: assignee === "none" ? { kind: "unassigned" } : isUuid(assignee) ? { kind: "person", id: assignee.toLowerCase() } : { kind: "any" },
    priority: isProjectPriority(priority) ? priority : null,
    minAgeDays: (REVIEW_AGES as readonly number[]).includes(age) ? (age as ReviewAge) : null,
    sort: (REVIEW_SORTS as readonly string[]).includes(sort ?? "") ? (sort as ReviewSort) : "oldest",
    page,
  };
}

export function hasActiveReviewFilters(query: ReviewQuery): boolean {
  return Boolean(query.search || query.projectId || query.priority || query.minAgeDays || query.assignee.kind !== "any");
}

export function reviewQueryToParams(query: ReviewQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search) params.set("q", query.search);
  if (query.projectId) params.set("project", query.projectId);
  if (query.assignee.kind === "unassigned") params.set("assignee", "none");
  if (query.assignee.kind === "person") params.set("assignee", query.assignee.id);
  if (query.priority) params.set("priority", query.priority);
  if (query.minAgeDays) params.set("age", String(query.minAgeDays));
  if (query.sort !== "oldest") params.set("sort", query.sort);
  if (query.page > 1) params.set("page", String(query.page));
  return params;
}

export function reviewsHref(query: ReviewQuery, overrides: Partial<ReviewQuery> = {}): string {
  const params = reviewQueryToParams({ ...query, ...overrides }).toString();
  return `/reviews${params ? `?${params}` : ""}`;
}

/** RPC arguments for list_review_queue (undefined = database default). */
export function reviewQueueArgs(query: ReviewQuery) {
  return {
    p_search: query.search || undefined,
    p_project_id: query.projectId ?? undefined,
    p_assignee_id: query.assignee.kind === "person" ? query.assignee.id : undefined,
    p_unassigned: query.assignee.kind === "unassigned",
    p_priority: query.priority ?? undefined,
    p_min_age_days: query.minAgeDays ?? undefined,
    p_sort: query.sort,
    p_page: query.page,
    p_page_size: REVIEW_PAGE_SIZE,
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type ReviewItem = {
  id: string;
  issueKey: string;
  type: WorkItemType;
  title: string;
  priority: ProjectPriority;
  projectId: string;
  projectName: string;
  projectKey: string;
  assigneeId: string | null;
  assigneeName: string | null;
  submittedAt: string;
};

/** `asOf`: when the queue was read (ms), the reference point for waiting times. */
export type ReviewPage = { items: ReviewItem[]; total: number; page: number; pageCount: number; asOf: number };

export type ReviewFacet = { id: string | null; label: string | null; projectKey: string | null; count: number; oldestSubmittedAt: string };
export type ReviewSummary = { total: number; oldestSubmittedAt: string | null; projects: ReviewFacet[]; assignees: ReviewFacet[] };

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
function count(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 0) throw new ProjectError("unexpected");
  return parsed;
}
function timestamp(row: Row, key: string): string {
  const value = str(row, key);
  if (Number.isNaN(Date.parse(value))) throw new ProjectError("unexpected");
  return value;
}

/** Only the listed fields leave the parser (no extra columns reach the client). */
export function toReviewItem(value: unknown): ReviewItem {
  const row = asRow(value);
  if (!isWorkItemType(row.type) || !isProjectPriority(row.priority)) throw new ProjectError("unexpected");
  return {
    id: str(row, "id"),
    issueKey: str(row, "issue_key"),
    type: row.type,
    title: str(row, "title"),
    priority: row.priority,
    projectId: str(row, "project_id"),
    projectName: str(row, "project_name"),
    projectKey: str(row, "project_key"),
    assigneeId: nullableStr(row, "assignee_id"),
    assigneeName: nullableStr(row, "assignee_name")?.trim() || null,
    submittedAt: timestamp(row, "submitted_at"),
  };
}

export function toReviewPage(rows: readonly unknown[], page: number, asOf: number, totalOverride?: number): ReviewPage {
  const items = rows.map(toReviewItem);
  const total = totalOverride ?? totalFromRows(rows);
  return { items, total, page, pageCount: Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE)), asOf };
}

export function totalFromRows(rows: readonly unknown[]): number {
  return rows.length ? count(asRow(rows[0]).total_count) : 0;
}

export function toReviewSummary(rows: readonly unknown[]): ReviewSummary {
  const projects: ReviewFacet[] = [];
  const assignees: ReviewFacet[] = [];
  for (const value of rows) {
    const row = asRow(value);
    const facet: ReviewFacet = {
      id: nullableStr(row, "id"),
      label: nullableStr(row, "label")?.trim() || null,
      projectKey: nullableStr(row, "project_key"),
      count: count(row.pending_count),
      oldestSubmittedAt: timestamp(row, "oldest_submitted_at"),
    };
    if (row.scope === "project") {
      if (!facet.id) throw new ProjectError("unexpected");
      projects.push(facet);
    } else if (row.scope === "assignee") assignees.push(facet);
    else throw new ProjectError("unexpected");
  }
  const total = projects.reduce((sum, facet) => sum + facet.count, 0);
  const oldest = projects.reduce<string | null>((min, facet) => (min === null || facet.oldestSubmittedAt < min ? facet.oldestSubmittedAt : min), null);
  return { total, oldestSubmittedAt: oldest, projects, assignees };
}

/** The summary after one item left the queue (approved, rejected or handled elsewhere). */
export function removeFromSummary(summary: ReviewSummary, item: Pick<ReviewItem, "projectId" | "assigneeId">): ReviewSummary {
  const dec = (facets: ReviewFacet[], id: string | null) =>
    facets.map((facet) => (facet.id === id ? { ...facet, count: facet.count - 1 } : facet)).filter((facet) => facet.count > 0);
  const projects = dec(summary.projects, item.projectId);
  return { ...summary, total: Math.max(0, summary.total - 1), projects, assignees: dec(summary.assignees, item.assigneeId) };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "12m", "5h", "2d 3h", "14d". Negative clock skew reads as "just now". */
export function formatWaiting(submittedAt: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(submittedAt));
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  const days = Math.floor(elapsed / DAY);
  const hours = Math.floor((elapsed % DAY) / HOUR);
  return days < 7 && hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export type WaitingTone = "fresh" | "aging" | "overdue";

/** Under a day is fresh, 1–3 days aging, over 3 days overdue. */
export function waitingTone(submittedAt: string, now: number): WaitingTone {
  const elapsed = now - Date.parse(submittedAt);
  if (elapsed >= 3 * DAY) return "overdue";
  if (elapsed >= DAY) return "aging";
  return "fresh";
}

const submittedFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
});

/** Deterministic (UTC) so server and client render the same text. */
export function formatSubmittedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `${submittedFormat.format(date)} UTC`;
}
