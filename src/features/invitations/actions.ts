"use server";
import { revalidatePath } from "next/cache";
import { inviteEmployee, resendInvitation, revokeInvitation } from "./operations.server";
import { InvitationError } from "./errors";
import type { InvitationFormState } from "./types";

async function perform(operation: () => Promise<void>): Promise<InvitationFormState> {
  try { await operation(); }
  catch (error) {
    if (!(error instanceof InvitationError)) throw error;
    revalidatePath("/employees/invitations");
    return { error: error.message, success: null };
  }
  revalidatePath("/employees"); revalidatePath("/employees/invitations");
  return { error: null, success: "Invitation updated." };
}
export async function inviteEmployeeAction(_state: InvitationFormState, data: FormData) {
  return perform(() => inviteEmployee({ email: data.get("email"), fullName: data.get("fullName"), role: data.get("role") }));
}
export async function resendInvitationAction(id: string) { return perform(() => resendInvitation(id)); }
export async function revokeInvitationAction(id: string) { return perform(() => revokeInvitation(id)); }
