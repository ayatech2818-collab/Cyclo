import { ProjectError } from "./errors";
import type { DeveloperOption, ProjectDetail, ProjectListItem, ProjectManagerOption, ProjectMember } from "./types";
import { isProjectPriority, isProjectStatus } from "./validation";
// Relative import keeps this module loadable by the plain-Node unit tests.
import { isAppRole } from "../employees/validation";

/*
 * Runtime parsers for project RPC rows. Each parser copies only its DTO's
 * fields, so an extra column can never leak into a response. Malformed rows
 * fail closed with an "unexpected" error.
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

function bool(row: Row, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new ProjectError("unexpected");
  return value;
}

export function toProjectListItem(value: unknown): ProjectListItem {
  const row = asRow(value);
  const { status, priority } = row;
  if (!isProjectStatus(status) || !isProjectPriority(priority)) throw new ProjectError("unexpected");
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    projectKey: str(row, "project_key"),
    description: nullableStr(row, "description"),
    status,
    priority,
    projectManagerId: str(row, "project_manager_id"),
    projectManagerName: nullableStr(row, "project_manager_name"),
    startDate: nullableStr(row, "start_date"),
    targetDate: nullableStr(row, "target_date"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
    archivedAt: nullableStr(row, "archived_at"),
  };
}

export function toProjectDetail(value: unknown): ProjectDetail {
  const row = asRow(value);
  return {
    ...toProjectListItem(row),
    projectManagerEmail: nullableStr(row, "project_manager_email"),
    projectManagerIsActive: bool(row, "project_manager_is_active"),
    createdBy: str(row, "created_by"),
    createdByName: nullableStr(row, "created_by_name"),
  };
}

export function toProjectManagerOption(value: unknown): ProjectManagerOption {
  const row = asRow(value);
  return { id: str(row, "id"), fullName: nullableStr(row, "full_name"), email: nullableStr(row, "email") };
}

export function toProjectMember(value: unknown): ProjectMember {
  const row = asRow(value);
  if (!isAppRole(row.role)) throw new ProjectError("unexpected");
  return {
    membershipId: str(row, "id"),
    profileId: str(row, "profile_id"),
    fullName: nullableStr(row, "full_name"),
    email: nullableStr(row, "email"),
    role: row.role,
    isActive: bool(row, "is_active"),
    addedBy: str(row, "added_by"),
    addedByName: nullableStr(row, "added_by_name"),
    addedAt: str(row, "created_at"),
  };
}

export function toDeveloperOption(value: unknown): DeveloperOption {
  const row = asRow(value);
  return { id: str(row, "id"), fullName: nullableStr(row, "full_name"), email: nullableStr(row, "email") };
}

/** total_count from the first row of a list_projects page (0 when empty). */
export function projectTotalCount(rows: readonly unknown[]): number {
  if (rows.length === 0) return 0;
  const total = asRow(rows[0]).total_count;
  const parsed = typeof total === "string" ? Number(total) : total;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) throw new ProjectError("unexpected");
  return parsed;
}
