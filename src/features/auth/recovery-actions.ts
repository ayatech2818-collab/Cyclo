"use server";

import { redirect } from "next/navigation";

import { validateOnboardingPassword } from "@/features/invitations/validation";
import { createClient } from "@/lib/supabase/server";

import { passwordUpdateError } from "./recovery";
import { getRecoverySession, recoveryRedirectUrl } from "./recovery.server";
import { validateEmail } from "./validation";

// ---------------------------------------------------------------------------
// Request a reset email
// ---------------------------------------------------------------------------

export type ForgotPasswordState = { sent: boolean; error: string | null };

/** Every accepted request takes at least this long, so timing does not reveal whether an email was sent. */
const MIN_REQUEST_MS = 900;

/**
 * Asks Supabase Auth to email a recovery link. The response is identical whether
 * or not the address belongs to an account: Auth errors (unknown user, per-user
 * cooldown, mail delivery) are logged by code only and never shown.
 */
export async function requestPasswordReset(_state: ForgotPasswordState, data: FormData): Promise<ForgotPasswordState> {
  const email = validateEmail(data.get("email"));
  if (!email) return { sent: false, error: "Enter a valid work email address." };

  const started = Date.now();
  try {
    const client = await createClient();
    const redirectTo = recoveryRedirectUrl();
    const { error } = await client.auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : undefined);
    if (error) console.error(`[auth] password reset request not sent: code=${error.code || error.status || "unknown"}`);
  } catch {
    console.error("[auth] password reset request failed");
  }
  const remaining = MIN_REQUEST_MS - (Date.now() - started);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  return { sent: true, error: null };
}

// ---------------------------------------------------------------------------
// Set the new password
// ---------------------------------------------------------------------------

export type ResetPasswordState = { error: string | null };

const EXPIRED = "Your reset link has expired. Request a new password-reset email.";

/**
 * Sets a new password for the account behind a fresh recovery session, then
 * signs that account out everywhere and returns to the login page.
 */
export async function resetPassword(_state: ResetPasswordState, data: FormData): Promise<ResetPasswordState> {
  const session = await getRecoverySession();
  if (!session) return { error: EXPIRED };

  let password: string;
  try {
    password = validateOnboardingPassword(data.get("password"), data.get("confirmation"));
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid password." };
  }

  const { error } = await session.client.auth.updateUser({ password });
  if (error) return { error: passwordUpdateError(error) };

  // Revoke every session of this account, including the recovery session.
  const { error: signOutError } = await session.client.auth.signOut({ scope: "global" });
  if (signOutError) await session.client.auth.signOut({ scope: "local" });

  redirect("/login?notice=password_updated");
}
