// Relative imports keep this module loadable by the plain-Node unit tests.
import { ProjectError } from "../projects/errors";
import { isProjectPriority } from "../projects/validation";
import type { ParentOption, WorkItemChild, WorkItemDetail, WorkItemListItem } from "./types";
import { isWorkItemStatus, isWorkItemType } from "./validation";

/*
 * Runtime parsers for work item RPC rows. Each copies only its DTO's fields;
 * malformed rows fail closed with an "unexpected" error.
 */

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProjectError("unexpected");
  return value as Row;
}

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new ProjectError("unexpected");
  return value;
}

function nullableStr(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ProjectError("unexpected");
  return value;
}

function nullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) throw new ProjectError("unexpected");
  return parsed;
}

function integer(row: Row, key: string): number {
  const value = nullableNumber(row, key);
  if (value === null || !Number.isSafeInteger(value) || value < 0) throw new ProjectError("unexpected");
  return value;
}

function enums(row: Row) {
  const { type, status, priority } = row;
  if (!isWorkItemType(type) || !isWorkItemStatus(status) || !isProjectPriority(priority)) throw new ProjectError("unexpected");
  return { type, status, priority };
}

export function toWorkItemListItem(value: unknown): WorkItemListItem {
  const row = asRow(value);
  return {
    id: str(row, "id"),
    issueKey: str(row, "issue_key"),
    ...enums(row),
    title: str(row, "title"),
    parentId: nullableStr(row, "parent_id"),
    parentIssueKey: nullableStr(row, "parent_issue_key"),
    assigneeId: nullableStr(row, "assignee_id"),
    assigneeName: nullableStr(row, "assignee_name"),
    dueDate: nullableStr(row, "due_date"),
    estimate: nullableNumber(row, "estimate"),
    childCount: integer(row, "child_count"),
    updatedAt: str(row, "updated_at"),
    archivedAt: nullableStr(row, "archived_at"),
  };
}

export function toWorkItemDetail(value: unknown): WorkItemDetail {
  const row = asRow(value);
  const blocked = row.blocked_from_status;
  if (blocked !== null && !isWorkItemStatus(blocked)) throw new ProjectError("unexpected");
  const parentId = nullableStr(row, "parent_id");
  const parentType = row.parent_type;
  if (parentId && !isWorkItemType(parentType)) throw new ProjectError("unexpected");
  const eligible = row.assignee_is_eligible;
  if (typeof eligible !== "boolean") throw new ProjectError("unexpected");
  return {
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    issueKey: str(row, "issue_key"),
    ...enums(row),
    title: str(row, "title"),
    description: nullableStr(row, "description"),
    blockedFromStatus: blocked,
    parent: parentId && isWorkItemType(parentType)
      ? { id: parentId, issueKey: str(row, "parent_issue_key"), title: str(row, "parent_title"), type: parentType }
      : null,
    assigneeId: nullableStr(row, "assignee_id"),
    assigneeName: nullableStr(row, "assignee_name"),
    assigneeEmail: nullableStr(row, "assignee_email"),
    assigneeIsEligible: eligible,
    reporterId: str(row, "reporter_id"),
    reporterName: nullableStr(row, "reporter_name"),
    startDate: nullableStr(row, "start_date"),
    dueDate: nullableStr(row, "due_date"),
    estimate: nullableNumber(row, "estimate"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
    completedAt: nullableStr(row, "completed_at"),
    archivedAt: nullableStr(row, "archived_at"),
  };
}

export function toWorkItemChild(value: unknown): WorkItemChild {
  const row = asRow(value);
  return {
    id: str(row, "id"),
    issueKey: str(row, "issue_key"),
    ...enums(row),
    title: str(row, "title"),
    assigneeName: nullableStr(row, "assignee_name"),
    archivedAt: nullableStr(row, "archived_at"),
  };
}

export function toParentOption(value: unknown): ParentOption {
  const row = asRow(value);
  const type = row.type;
  if (!isWorkItemType(type)) throw new ProjectError("unexpected");
  return { id: str(row, "id"), issueKey: str(row, "issue_key"), type, title: str(row, "title") };
}

export function workItemTotal(rows: readonly unknown[]): number {
  return rows.length === 0 ? 0 : integer(asRow(rows[0]), "total_count");
}
