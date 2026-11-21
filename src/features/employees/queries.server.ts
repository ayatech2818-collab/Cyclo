import "server-only";

import type { ActiveProfile } from "@/features/auth/access";
import { requireActiveProfile } from "@/features/auth/server";
import { createClient } from "@/lib/supabase/server";

import { toAdminDetail, toDirectoryItem, toOwnProfile, totalCount } from "./dto";
import { EmployeeError, describeDatabaseFailure, mapDatabaseError } from "./errors";
import {
  DIRECTORY_ROLES,
  type EmployeeAdminDetail,
  type EmployeeDirectoryItem,
  type EmployeeDirectoryPage,
  type EmployeeDirectoryQuery,
  type OwnProfile,
} from "./types";
import { isUuid } from "./validation";

/*
 * Server-only employee reads.
 *
 * Every function re-checks the caller in the application (fast failure, clear
 * errors) and then calls an RPC that independently enforces the same rule in
 * the database. Results are parsed into role-specific DTOs.
 */

type RpcError = { code?: string | null; message?: string | null };

function fail(operation: string, error: RpcError): never {
  const code = mapDatabaseError(error);
  if (code === "unexpected" || code === "unavailable") {
    console.error(describeDatabaseFailure(operation, error));
  }
  throw new EmployeeError(code);
}

async function requireRole(roles: readonly ActiveProfile["role"][]): Promise<ActiveProfile> {
  // Redirects to /login when the session or profile is not valid.
  const { profile } = await requireActiveProfile();
  if (!roles.includes(profile.role)) throw new EmployeeError("forbidden");
  return profile;
}

export async function listEmployees(query: EmployeeDirectoryQuery): Promise<EmployeeDirectoryPage> {
  await requireRole(DIRECTORY_ROLES);
  const supabase = await createClient();

  const fetchPage = (page: number, pageSize: number) =>
    supabase.rpc("list_employees", {
      p_search: query.search || undefined,
      p_role: query.role ?? undefined,
      p_is_active: query.status === "all" ? undefined : query.status === "active",
      p_page: page,
      p_page_size: pageSize,
    });

  const { data, error } = await fetchPage(query.page, query.pageSize);
  if (error) fail("list_employees", error);

  const rows: unknown[] = data ?? [];
  let total = totalCount(rows);

  // A page past the end returns no rows and therefore no count; fetch it once
  // so the UI can offer a way back instead of claiming there are no employees.
  if (rows.length === 0 && query.page > 1) {
    const probe = await fetchPage(1, 1);
    if (probe.error) fail("list_employees", probe.error);
    total = totalCount(probe.data ?? []);
  }

  return {
    items: rows.map(toDirectoryItem),
    total,
    page: query.page,
    pageSize: query.pageSize,
    pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/** Directory detail for Super Admins and Project Managers. Returns null when not found. */
export async function getEmployee(id: string): Promise<EmployeeDirectoryItem | null> {
  await requireRole(DIRECTORY_ROLES);
  if (!isUuid(id)) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_employee", { p_employee_id: id });
  if (error) fail("get_employee", error);
  const rows: unknown[] = data ?? [];
  return rows.length ? toDirectoryItem(rows[0]) : null;
}

/** Administrative detail for Super Admins only. Returns null when not found. */
export async function adminGetEmployee(id: string): Promise<EmployeeAdminDetail | null> {
  await requireRole(["SUPER_ADMIN"]);
  if (!isUuid(id)) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_get_employee", { p_employee_id: id });
  if (error) fail("admin_get_employee", error);
  const rows: unknown[] = data ?? [];
  return rows.length ? toAdminDetail(rows[0]) : null;
}

/** The signed-in employee's own profile (any active role). */
export async function getMyProfile(): Promise<OwnProfile> {
  await requireActiveProfile();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_my_profile");
  if (error) fail("get_my_profile", error);
  const rows: unknown[] = data ?? [];
  if (!rows.length) throw new EmployeeError("not_found");
  return toOwnProfile(rows[0]);
}
