"use server";

import { revalidatePath } from "next/cache";
import { EmployeeError } from "./errors";
import { updateEmployeeDetails, setEmployeeCode, setEmployeeRole, setEmployeeActive, setGitOrganizer } from "./mutations.server";
import type { EmployeeAdminDetail } from "./types";

export type EmployeeActionState = { error: string | null; success: string | null };
async function perform(operation: () => Promise<EmployeeAdminDetail>): Promise<EmployeeActionState> {
  let employee: EmployeeAdminDetail;
  try { employee = await operation(); }
  catch (error) {
    if (error instanceof EmployeeError) return { error: error.message, success: null };
    throw error; // Preserve Next.js authentication redirects.
  }
  revalidatePath("/employees");
  revalidatePath(`/employees/${employee.id}`);
  return { error: null, success: "Employee saved." };
}
function field(data: FormData, name: string): string {
  const value = data.get(name);
  if (typeof value !== "string") throw new EmployeeError("invalid_input");
  return value;
}
function flag(data: FormData, name: string): boolean {
  const value = field(data, name);
  if (value !== "true" && value !== "false") throw new EmployeeError("invalid_input");
  return value === "true";
}
export async function updateEmployeeDetailsAction(id: string, _state: EmployeeActionState, data: FormData) {
  return perform(() => updateEmployeeDetails(id, { fullName: field(data,"fullName"), avatarUrl: field(data,"avatarUrl") }));
}
export async function setEmployeeCodeAction(id: string, _state: EmployeeActionState, data: FormData) {
  return perform(() => setEmployeeCode(id, field(data,"employeeCode")));
}
export async function setEmployeeRoleAction(id: string, _state: EmployeeActionState, data: FormData) {
  return perform(() => setEmployeeRole(id, field(data,"role")));
}
export async function setEmployeeActiveAction(id: string, _state: EmployeeActionState, data: FormData) {
  return perform(() => setEmployeeActive(id, flag(data,"isActive")));
}
export async function setGitOrganizerAction(id: string, _state: EmployeeActionState, data: FormData) {
  return perform(() => setGitOrganizer(id, flag(data,"isGitOrganizer")));
}
