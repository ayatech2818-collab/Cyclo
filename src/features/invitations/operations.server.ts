import "server-only";
import { requireActiveProfile } from "@/features/auth/server";
import { createClient } from "@/lib/supabase/server";
import { createAuthAdminClient, invitationCallbackUrl } from "@/lib/supabase/admin.server";
import { isAppRole, isUuid } from "@/features/employees/validation";
import { InvitationError, invitationFailure } from "./errors";
import { INVITATION_STATUSES, type Invitation } from "./types";
import { validateInvitation } from "./validation";
import type { Database } from "@/types/database";

type Functions = Database["public"]["Functions"];
type Name = "admin_create_employee_invitation" | "admin_list_employee_invitations" | "admin_resend_employee_invitation" | "admin_revoke_employee_invitation" | "admin_record_invitation_delivery" | "get_my_employee_invitation" | "accept_employee_invitation" | "start_employee_onboarding" | "complete_employee_onboarding";
function dto(value: unknown): Invitation {
  if (!value || typeof value !== "object") throw new InvitationError("Invalid invitation response.");
  const row = value as Record<string, unknown>;
  if (!isUuid(row.id) || !isAppRole(row.assigned_role) || typeof row.email !== "string" || typeof row.full_name !== "string" || typeof row.status !== "string" || !(INVITATION_STATUSES as readonly string[]).includes(row.status) || typeof row.created_at !== "string" || typeof row.expires_at !== "string" || (row.last_sent_at !== null && typeof row.last_sent_at !== "string") || typeof row.delivery_failed !== "boolean") throw new InvitationError("Invalid invitation response.");
  if (row.auth_user_id !== null && !isUuid(row.auth_user_id)) throw new InvitationError("Invalid invitation response.");
  return { id: row.id, email: row.email, fullName: row.full_name, role: row.assigned_role, authUserId: row.auth_user_id, status: row.status as Invitation["status"], createdAt: row.created_at, expiresAt: row.expires_at, lastSentAt: row.last_sent_at, deliveryFailed: row.delivery_failed };
}
export async function invitationRpc<N extends Name>(name: N, args: Functions[N]["Args"]): Promise<Invitation[]> {
  const client = await createClient();
  const { data, error } = await client.rpc(name, args);
  if (error) throw invitationFailure(error);
  // The SDK's generic RPC conditional cannot resolve this fixed name union;
  // runtime parsing still fails closed and copies only the DTO allowlist.
  const rows: unknown = data ?? [];
  if (!Array.isArray(rows)) throw new InvitationError("Invalid invitation response.");
  return rows.map(dto);
}
async function requireAdmin() {
  const access = await requireActiveProfile();
  if (access.profile.role !== "SUPER_ADMIN") throw new InvitationError("You do not have permission to manage invitations.");
}
function id(value: string) { if (!isUuid(value)) throw new InvitationError("Invalid invitation."); return value; }
async function send(invitation: Invitation): Promise<void> {
  // Authorization precedes obtaining the secret client and every Admin API call.
  await requireAdmin();
  let success = false;
  try {
    const admin = createAuthAdminClient();
    const linked = invitation.authUserId ? await admin.auth.admin.getUserById(invitation.authUserId) : null;
    if (linked?.error) throw new Error("Linked Auth account unavailable.");
    if (linked?.data.user.email_confirmed_at) {
      if (linked.data.user.email?.toLowerCase() !== invitation.email) throw new Error("Invitation identity mismatch.");
      // Auth will not re-invite a verified account. Auth itself generates and
      // sends this resume email; no application mailer or manual link exists.
      const { error } = await admin.auth.signInWithOtp({ email: invitation.email, options: { shouldCreateUser: false, emailRedirectTo: invitationCallbackUrl() } });
      success = !error;
    } else {
      const { error } = await admin.auth.admin.inviteUserByEmail(invitation.email, { redirectTo: invitationCallbackUrl() });
      success = !error;
    }
  } catch { /* Never return SDK messages, credentials or tokens. */ }
  await invitationRpc("admin_record_invitation_delivery", { p_invitation_id: invitation.id, p_success: success });
  if (!success) throw new InvitationError("Invitation saved, but email delivery failed. Check local Auth configuration and use Resend.");
}
export async function inviteEmployee(input: { email: unknown; fullName: unknown; role: unknown }) {
  await requireAdmin();
  let values;
  try { values = validateInvitation(input); } catch (error) { throw new InvitationError(error instanceof Error ? error.message : "Invalid invitation."); }
  const [invitation] = await invitationRpc("admin_create_employee_invitation", { p_email: values.email, p_full_name: values.fullName, p_role: values.role });
  if (!invitation) throw new InvitationError("Invitation could not be created.");
  await send(invitation);
}
export async function listInvitations() { await requireAdmin(); return invitationRpc("admin_list_employee_invitations", {}); }
export async function resendInvitation(invitationId: string) {
  await requireAdmin();
  const [invitation] = await invitationRpc("admin_resend_employee_invitation", { p_invitation_id: id(invitationId) });
  if (!invitation) throw new InvitationError("Invitation not found.");
  await send(invitation);
}
export async function revokeInvitation(invitationId: string) {
  await requireAdmin();
  await invitationRpc("admin_revoke_employee_invitation", { p_invitation_id: id(invitationId) });
}
