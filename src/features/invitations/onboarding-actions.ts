"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireOnboarding } from "./onboarding.server";
import { invitationRpc } from "./operations.server";
import { InvitationError } from "./errors";
import { validateOnboardingPassword } from "./validation";
import type { InvitationFormState } from "./types";

export async function setOnboardingPassword(_state: InvitationFormState, data: FormData): Promise<InvitationFormState> {
  const { client, invitation } = await requireOnboarding();
  if (invitation.status !== "ACCEPTED") return { error: "Open a valid invitation before setting a password.", success: null };
  let password;
  try { password = validateOnboardingPassword(data.get("password"), data.get("confirmation")); }
  catch (error) { return { error: error instanceof Error ? error.message : "Invalid password.", success: null }; }
  const { error } = await client.auth.updateUser({ password });
  if (error) return { error: "The password could not be saved. Please try a different password.", success: null };
  try { await invitationRpc("start_employee_onboarding", {}); }
  catch (error) { if (error instanceof InvitationError) return { error: error.message, success: null }; throw error; }
  revalidatePath("/onboarding");
  redirect("/onboarding/complete");
}
export async function completeOnboarding(_state: InvitationFormState, data: FormData): Promise<InvitationFormState> {
  const { invitation } = await requireOnboarding();
  if (invitation.status !== "ONBOARDING") return { error: "Complete password setup first.", success: null };
  const fullName = data.get("fullName");
  if (typeof fullName !== "string" || !fullName.trim() || [...fullName.trim()].length > 200) return { error: "Full name must contain 1–200 characters.", success: null };
  try { await invitationRpc("complete_employee_onboarding", { p_full_name: fullName.trim() }); }
  catch (error) { if (error instanceof InvitationError) return { error: error.message, success: null }; throw error; }
  revalidatePath("/", "layout");
  redirect("/dashboard");
}
