import "server-only";

import { requireActiveProfile } from "@/features/auth/server";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";
import { toAdminDetail } from "./dto";
import { EmployeeError, describeDatabaseFailure, mapDatabaseError } from "./errors";
import { validateEmployeeId, validateEmployeeDetails, validateEmployeeCode, validateEmployeeRole, validateEmployeeBoolean } from "./mutation-validation";
import type { EmployeeAdminDetail } from "./types";

type Functions = Database["public"]["Functions"];
type MutationName = "admin_update_employee_details" | "admin_set_employee_code" | "admin_set_employee_role" | "admin_set_employee_active" | "admin_set_git_organizer";
async function authorize() {
  const { profile } = await requireActiveProfile();
  if (profile.role !== "SUPER_ADMIN") throw new EmployeeError("forbidden");
  return profile;
}
async function mutate<N extends MutationName>(name: N, args: Functions[N]["Args"]): Promise<EmployeeAdminDetail> {
  const client = await createClient();
  let result;
  try { result = await client.rpc(name, args); }
  catch { throw new EmployeeError("unavailable"); }
  if (result.error) {
    const code = mapDatabaseError(result.error);
    if (code === "unexpected" || code === "unavailable") console.error(describeDatabaseFailure(name, result.error));
    throw new EmployeeError(code);
  }
  if (!result.data?.length) throw new EmployeeError("not_found");
  return toAdminDetail(result.data[0]);
}
export async function updateEmployeeDetails(id: string, input: { fullName: string; avatarUrl: string | null }) {
  await authorize(); validateEmployeeId(id);
  const values = validateEmployeeDetails(input.fullName, input.avatarUrl);
  return mutate("admin_update_employee_details", { p_employee_id: id, p_full_name: values.fullName, p_avatar_url: values.avatarUrl ?? "" });
}
export async function setEmployeeCode(id: string, code: string | null) {
  await authorize(); validateEmployeeId(id);
  return mutate("admin_set_employee_code", { p_employee_id: id, p_employee_code: validateEmployeeCode(code) ?? "" });
}
export async function setEmployeeRole(id: string, role: string) {
  const actor = await authorize(); validateEmployeeId(id);
  const value = validateEmployeeRole(role);
  if (actor.id === id && value !== "SUPER_ADMIN") throw new EmployeeError("self_management");
  return mutate("admin_set_employee_role", { p_employee_id: id, p_role: value });
}
export async function setEmployeeActive(id: string, active: boolean) {
  const actor = await authorize(); validateEmployeeId(id);
  const value = validateEmployeeBoolean(active);
  if (actor.id === id && !value) throw new EmployeeError("self_management");
  return mutate("admin_set_employee_active", { p_employee_id: id, p_is_active: value });
}
export async function setGitOrganizer(id: string, enabled: boolean) {
  await authorize(); validateEmployeeId(id);
  return mutate("admin_set_git_organizer", { p_employee_id: id, p_is_git_organizer: validateEmployeeBoolean(enabled) });
}
