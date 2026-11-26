// Relative imports keep this module loadable by the plain-Node unit tests.
import { ProjectError } from "../projects/errors";
import { isProjectPriority } from "../projects/validation";
import type { ProjectPriority } from "../projects/types";
import { WORK_STATUS_LABELS, type WorkItemStatus, type WorkItemType } from "./types";
import { isWorkItemStatus, isWorkItemType, nextStatuses } from "./validation";

/*
 * Developer execution workflow (Phase 8F2), pure logic shared by the sprint
 * board and the work item page. The database (private.execute_work_item and
 * the workflow guard trigger) decides every move again; these are UI gates.
 *
 *   start          TODO        → IN_PROGRESS   assignee or manager
 *   submit_review  IN_PROGRESS → IN_REVIEW     assignee or manager (never DONE)
 *   block          TODO/IN_PROGRESS/IN_REVIEW → BLOCKED (reason)
 *   resume         BLOCKED     → the status it was blocked from
 *   approve        IN_REVIEW   → DONE          manager only
 *   reject         IN_REVIEW   → IN_PROGRESS   manager only (reason)
 *
 * Everything else (mark ready, back to to-do, cancel, reopen) stays a
 * generic workflow transition.
 */

export const EXECUTION_ACTIONS = ["start", "submit_review", "block", "resume", "approve", "reject"] as const;
export type ExecutionAction = (typeof EXECUTION_ACTIONS)[number];

export function isExecutionAction(value: unknown): value is ExecutionAction {
  return typeof value === "string" && (EXECUTION_ACTIONS as readonly string[]).includes(value);
}

export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** Trimmed reason or null when it would be refused (3–500 characters, no control characters). */
export function parseReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX || /[\u0000-\u001f\u007f]/.test(reason)) return null;
  return reason;
}

export type MoveTone = "primary" | "neutral" | "success" | "danger";

export type Move = {
  /** Target status (for resume: the status the item was blocked from). */
  to: WorkItemStatus;
  /** Execution action, or null for a generic workflow transition. */
  action: ExecutionAction | null;
  label: string;
  needsReason: boolean;
  /** Confirmation prompt shown before the move runs. */
  confirm: string | null;
  tone: MoveTone;
};

export type MoveSubject = { status: WorkItemStatus; blockedFromStatus: WorkItemStatus | null; assigneeId: string | null };
export type MoveViewer = { id: string; isManager: boolean; writable: boolean };

const EXECUTION_MOVES: Record<ExecutionAction, Omit<Move, "to">> = {
  start: { action: "start", label: "Start work", needsReason: false, confirm: "Start work on this item? It moves to In progress.", tone: "primary" },
  submit_review: { action: "submit_review", label: "Submit for review", needsReason: false, confirm: null, tone: "primary" },
  block: { action: "block", label: "Mark blocked", needsReason: true, confirm: null, tone: "danger" },
  resume: { action: "resume", label: "Resume", needsReason: false, confirm: null, tone: "primary" },
  approve: { action: "approve", label: "Approve", needsReason: false, confirm: null, tone: "success" },
  reject: { action: "reject", label: "Request changes", needsReason: true, confirm: null, tone: "neutral" },
};

const GENERIC_LABELS: Partial<Record<`${WorkItemStatus}>${WorkItemStatus}`, string>> = {
  "BACKLOG>TODO": "Mark ready",
  "TODO>BACKLOG": "Back to backlog",
  "IN_PROGRESS>TODO": "Back to to do",
  "DONE>IN_PROGRESS": "Reopen",
  "CANCELLED>BACKLOG": "Restore to backlog",
};

/** The execution action behind a transition, if one exists. */
export function executionActionFor(from: WorkItemStatus, to: WorkItemStatus, blockedFrom: WorkItemStatus | null): ExecutionAction | null {
  if (from === "TODO" && to === "IN_PROGRESS") return "start";
  if (from === "IN_PROGRESS" && to === "IN_REVIEW") return "submit_review";
  if (to === "BLOCKED" && (from === "TODO" || from === "IN_PROGRESS" || from === "IN_REVIEW")) return "block";
  if (from === "BLOCKED" && to !== "CANCELLED" && to === blockedFrom) return "resume";
  if (from === "IN_REVIEW" && to === "DONE") return "approve";
  if (from === "IN_REVIEW" && to === "IN_PROGRESS") return "reject";
  return null;
}

/**
 * Moves the viewer may make, in workflow order. Developers act only on their
 * own items and never approve, reject, cancel or reopen.
 */
export function availableMoves(item: MoveSubject, viewer: MoveViewer): Move[] {
  if (!viewer.writable) return [];
  const isAssignee = item.assigneeId !== null && item.assigneeId === viewer.id;
  if (!viewer.isManager && !isAssignee) return [];
  return nextStatuses(item.status, item.blockedFromStatus, viewer.isManager).map((to): Move => {
    const action = executionActionFor(item.status, to, item.blockedFromStatus);
    if (action) return { to, ...EXECUTION_MOVES[action], label: action === "resume" ? `Resume (${WORK_STATUS_LABELS[to]})` : EXECUTION_MOVES[action].label };
    return {
      to,
      action: null,
      label: GENERIC_LABELS[`${item.status}>${to}`] ?? (to === "CANCELLED" ? "Cancel" : `Move to ${WORK_STATUS_LABELS[to]}`),
      needsReason: false,
      confirm: to === "CANCELLED" ? "Cancel this item? It no longer counts towards the sprint." : null,
      tone: to === "CANCELLED" ? "danger" : "neutral",
    };
  });
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export const BOARD_COLUMNS = ["TODO", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "DONE"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Not-yet-ready work sits in To do; cancelled work is not on the board. */
export function boardColumnOf(status: WorkItemStatus): BoardColumn | null {
  if (status === "BACKLOG") return "TODO";
  if (status === "CANCELLED") return null;
  return status;
}

/** The move a drop onto `column` means, or null when the viewer cannot make it. */
export function moveForColumn(item: MoveSubject, column: BoardColumn, viewer: MoveViewer): Move | null {
  if (boardColumnOf(item.status) === column) return null;
  return availableMoves(item, viewer).find((move) => boardColumnOf(move.to) === column) ?? null;
}

export type BoardItem = {
  id: string;
  issueKey: string;
  type: WorkItemType;
  title: string;
  status: WorkItemStatus;
  blockedFromStatus: WorkItemStatus | null;
  blockedReason: string | null;
  priority: ProjectPriority;
  assigneeId: string | null;
  assigneeName: string | null;
  estimate: number | null;
  rank: number;
  updatedAt: string;
};

export type BoardFilters = { search: string; assignee: "any" | "mine" | "unassigned" | string; type: WorkItemType | null; priority: ProjectPriority | null };
export const EMPTY_BOARD_FILTERS: BoardFilters = { search: "", assignee: "any", type: null, priority: null };

export function filterBoard(items: readonly BoardItem[], filters: BoardFilters, viewerId: string): BoardItem[] {
  const search = filters.search.trim().toLowerCase();
  return items.filter((item) => {
    if (search && !item.title.toLowerCase().includes(search) && !item.issueKey.toLowerCase().includes(search)) return false;
    if (filters.type && item.type !== filters.type) return false;
    if (filters.priority && item.priority !== filters.priority) return false;
    if (filters.assignee === "mine") return item.assigneeId === viewerId;
    if (filters.assignee === "unassigned") return item.assigneeId === null;
    if (filters.assignee !== "any") return item.assigneeId === filters.assignee;
    return true;
  });
}

export type BoardColumnGroup = { column: BoardColumn; items: BoardItem[]; count: number; points: number; unestimated: number };

const PRIORITY_ORDER: Record<ProjectPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Groups into the five columns (backlog rank, then priority, then key). */
export function groupBoard(items: readonly BoardItem[]): BoardColumnGroup[] {
  const groups = new Map<BoardColumn, BoardItem[]>(BOARD_COLUMNS.map((column) => [column, []]));
  for (const item of items) {
    const column = boardColumnOf(item.status);
    if (column) groups.get(column)!.push(item);
  }
  return BOARD_COLUMNS.map((column) => {
    const list = groups.get(column)!.sort((a, b) => a.rank - b.rank || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.issueKey.localeCompare(b.issueKey, "en", { numeric: true }));
    return {
      column,
      items: list,
      count: list.length,
      points: roundPoints(list.reduce((sum, item) => sum + (item.estimate ?? 0), 0)),
      unestimated: list.filter((item) => item.estimate === null).length,
    };
  });
}

function roundPoints(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Applies a server-confirmed (or optimistic) status to one card. */
export function patchBoardItem(items: readonly BoardItem[], id: string, patch: Partial<Pick<BoardItem, "status" | "blockedFromStatus" | "blockedReason" | "updatedAt">>): BoardItem[] {
  return items.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

/** What the card looks like right after a move, before the server answers. */
export function optimisticPatch(item: BoardItem, move: Move, reason: string | null): Pick<BoardItem, "status" | "blockedFromStatus" | "blockedReason"> {
  if (move.to === "BLOCKED") return { status: "BLOCKED", blockedFromStatus: item.status, blockedReason: reason };
  return { status: move.to, blockedFromStatus: null, blockedReason: null };
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
function num(value: unknown): number {
  const parsed = nullableNumber(value);
  if (parsed === null) throw new ProjectError("unexpected");
  return parsed;
}
function nullableStatus(value: unknown): WorkItemStatus | null {
  if (value === null || value === undefined) return null;
  if (!isWorkItemStatus(value)) throw new ProjectError("unexpected");
  return value;
}

export function toBoardItem(value: unknown): BoardItem {
  const row = asRow(value);
  const { type, status, priority } = row;
  if (!isWorkItemType(type) || !isWorkItemStatus(status) || !isProjectPriority(priority)) throw new ProjectError("unexpected");
  return {
    id: str(row, "id"),
    issueKey: str(row, "issue_key"),
    type,
    title: str(row, "title"),
    status,
    blockedFromStatus: nullableStatus(row.blocked_from_status),
    blockedReason: nullableStr(row, "blocked_reason"),
    priority,
    assigneeId: nullableStr(row, "assignee_id"),
    assigneeName: nullableStr(row, "assignee_name"),
    estimate: nullableNumber(row.estimate),
    rank: nullableNumber(row.backlog_rank) ?? Number.MAX_SAFE_INTEGER,
    updatedAt: str(row, "updated_at"),
  };
}

export type ExecutionResult = {
  id: string;
  status: WorkItemStatus;
  blockedFromStatus: WorkItemStatus | null;
  blockedReason: string | null;
  updatedAt: string;
  /** False when the request was a retry of one that already succeeded. */
  changed: boolean;
};

export function toExecutionResult(value: unknown): ExecutionResult {
  const row = asRow(value);
  const status = nullableStatus(row.status);
  if (!status || typeof row.changed !== "boolean") throw new ProjectError("unexpected");
  return {
    id: str(row, "id"),
    status,
    blockedFromStatus: nullableStatus(row.blocked_from_status),
    blockedReason: nullableStr(row, "blocked_reason"),
    updatedAt: str(row, "updated_at"),
    changed: row.changed,
  };
}

export type ProgressSummary = {
  totalItems: number;
  completedItems: number;
  remainingItems: number;
  cancelledItems: number;
  totalPoints: number;
  completedPoints: number;
  remainingPoints: number;
  unestimatedItems: number;
  completionPercent: number;
};
export type ProgressRow = ProgressSummary & { assigneeId: string | null; assigneeName: string | null };
export type SprintProgress = { total: ProgressSummary; byAssignee: ProgressRow[] };

const EMPTY_PROGRESS: ProgressSummary = {
  totalItems: 0, completedItems: 0, remainingItems: 0, cancelledItems: 0, totalPoints: 0, completedPoints: 0, remainingPoints: 0, unestimatedItems: 0, completionPercent: 0,
};

function toSummary(row: Row): ProgressSummary {
  const percent = num(row.completion_percent);
  if (percent < 0 || percent > 100) throw new ProjectError("unexpected");
  return {
    totalItems: num(row.total_items),
    completedItems: num(row.completed_items),
    remainingItems: num(row.remaining_items),
    cancelledItems: num(row.cancelled_items),
    totalPoints: num(row.total_points),
    completedPoints: num(row.completed_points),
    remainingPoints: num(row.remaining_points),
    unestimatedItems: num(row.unestimated_items),
    completionPercent: percent,
  };
}

/** One 'total' row plus one 'assignee' row per person (private.sprint_progress). */
export function toSprintProgress(rows: readonly unknown[]): SprintProgress {
  let total: ProgressSummary = EMPTY_PROGRESS;
  const byAssignee: ProgressRow[] = [];
  for (const value of rows) {
    const row = asRow(value);
    if (row.scope === "total") total = toSummary(row);
    else if (row.scope === "assignee") byAssignee.push({ ...toSummary(row), assigneeId: nullableStr(row, "assignee_id"), assigneeName: nullableStr(row, "assignee_name") });
    else throw new ProjectError("unexpected");
  }
  return { total, byAssignee };
}

/** Same rule as private.sprint_progress: points when anything is estimated, else items; floored. */
export function completionPercent(summary: Pick<ProgressSummary, "totalPoints" | "completedPoints" | "totalItems" | "completedItems">): number {
  if (summary.totalPoints > 0) return Math.floor((summary.completedPoints / summary.totalPoints) * 100);
  return summary.totalItems > 0 ? Math.floor((summary.completedItems / summary.totalItems) * 100) : 0;
}

/**
 * Progress of the cards on the board, by the rules of private.sprint_progress
 * (the board holds the same non-archived, non-cancelled items). Lets the board
 * update its summary after a move without reloading.
 */
export function summarizeBoard(items: readonly Pick<BoardItem, "status" | "estimate">[], cancelledItems: number): ProgressSummary {
  const open = items.filter((item) => item.status !== "CANCELLED");
  const done = open.filter((item) => item.status === "DONE");
  const points = (list: typeof open) => roundPoints(list.reduce((sum, item) => sum + (item.estimate ?? 0), 0));
  const summary = {
    totalItems: open.length,
    completedItems: done.length,
    remainingItems: open.length - done.length,
    cancelledItems,
    totalPoints: points(open),
    completedPoints: points(done),
    remainingPoints: roundPoints(points(open) - points(done)),
    unestimatedItems: open.filter((item) => item.estimate === null).length,
  };
  return { ...summary, completionPercent: completionPercent(summary) };
}

export type ExecutionContext = {
  sprintId: string | null;
  sprintName: string | null;
  sprintStatus: "PLANNING" | "ACTIVE" | "COMPLETED" | "CANCELLED" | null;
  blockedReason: string | null;
  lastReview: { decision: "approved" | "rejected"; reason: string | null; at: string; by: string | null } | null;
};

export function toExecutionContext(value: unknown): ExecutionContext {
  const row = asRow(value);
  const sprintStatus = row.sprint_status ?? null;
  if (sprintStatus !== null && !["PLANNING", "ACTIVE", "COMPLETED", "CANCELLED"].includes(sprintStatus as string)) throw new ProjectError("unexpected");
  const action = nullableStr(row, "last_review_action");
  let lastReview: ExecutionContext["lastReview"] = null;
  if (action !== null) {
    if (action !== "WORK_ITEM_REVIEW_APPROVED" && action !== "WORK_ITEM_REVIEW_REJECTED") throw new ProjectError("unexpected");
    lastReview = { decision: action === "WORK_ITEM_REVIEW_APPROVED" ? "approved" : "rejected", reason: nullableStr(row, "last_review_reason"), at: str(row, "last_review_at"), by: nullableStr(row, "last_review_by") };
  }
  return {
    sprintId: nullableStr(row, "sprint_id"),
    sprintName: nullableStr(row, "sprint_name"),
    sprintStatus: sprintStatus as ExecutionContext["sprintStatus"],
    blockedReason: nullableStr(row, "blocked_reason"),
    lastReview,
  };
}
