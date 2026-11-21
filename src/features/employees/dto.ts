import { EmployeeError } from "./errors";
import type { EmployeeAdminDetail, EmployeeDirectoryItem, OwnProfile } from "./types";
import { isAppRole } from "./validation";

/*
 * Runtime parsers for RPC rows. Each parser copies only the fields of its DTO,
 * so a column accidentally added to an RPC can never leak into a response.
 * A malformed row fails closed with an "unexpected" error.
 */

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EmployeeError("unexpected");
  return value as Row;
}

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new EmployeeError("unexpected");
  return value;
}

function nullableStr(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new EmployeeError("unexpected");
  return value;
}

function bool(row: Row, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new EmployeeError("unexpected");
  return value;
}

export function toDirectoryItem(value: unknown): EmployeeDirectoryItem {
  const row = asRow(value);
  const role = row.role;
  if (!isAppRole(role)) throw new EmployeeError("unexpected");
  return {
    id: str(row, "id"),
    fullName: nullableStr(row, "full_name"),
    avatarUrl: nullableStr(row, "avatar_url"),
    email: nullableStr(row, "email"),
    employeeCode: nullableStr(row, "employee_code"),
    role,
    isActive: bool(row, "is_active"),
  };
}

export function toAdminDetail(value: unknown): EmployeeAdminDetail {
  const row = asRow(value);
  return {
    ...toDirectoryItem(row),
    isGitOrganizer: bool(row, "is_git_organizer"),
    invitedBy: nullableStr(row, "invited_by"),
    invitedByName: nullableStr(row, "invited_by_name"),
    onboardedAt: nullableStr(row, "onboarded_at"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  };
}

export function toOwnProfile(value: unknown): OwnProfile {
  const row = asRow(value);
  return {
    ...toDirectoryItem(row),
    isGitOrganizer: bool(row, "is_git_organizer"),
    onboardedAt: nullableStr(row, "onboarded_at"),
  };
}

/** Reads total_count from the first row of a list_employees page (0 when empty). */
export function totalCount(rows: readonly unknown[]): number {
  if (rows.length === 0) return 0;
  const total = asRow(rows[0]).total_count;
  const parsed = typeof total === "string" ? Number(total) : total;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) throw new EmployeeError("unexpected");
  return parsed;
}
