"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getAccess } from "@/features/auth/access";
import { validateCredentials } from "@/features/auth/validation";
import { createClient } from "@/lib/supabase/server";

/** `email` echoes the submitted address (never the password) so a failed attempt keeps it in the form. */
export type AuthFormState = { error: string | null; email?: string };

export async function login(_previousState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const result = await signIn(formData);
  return { ...result, email: submittedEmail(formData) };
}

function submittedEmail(formData: FormData): string {
  const value = formData.get("email");
  return typeof value === "string" ? value.trim().slice(0, 254) : "";
}

async function signIn(formData: FormData): Promise<{ error: string | null }> {
  const credentials = validateCredentials(formData);
  if ("error" in credentials) return { error: credentials.error };

  const supabase = await createClient();
  let destination = "/dashboard";
  try {
    const { error } = await supabase.auth.signInWithPassword(credentials);
    if (error) {
      if (error.status === 429) return { error: "Too many sign-in attempts. Please try again later." };
      if (!error.status || error.status >= 500) {
        return { error: "Sign-in is temporarily unavailable. Please try again." };
      }
      return { error: "Unable to sign in. Check your email and password and confirm your account is enabled." };
    }

    const access = await getAccess(supabase);
    if (access.status !== "authorized") {
      // Resume only a confirmed user's own accepted/in-progress invitation.
      // Inactive accounts without a valid invitation still fail closed.
      const invitation = await supabase.rpc("get_my_employee_invitation");
      const own = invitation.error ? null : invitation.data?.[0];
      if (own && ["ACCEPTED", "ONBOARDING"].includes(own.status)) {
        destination = own.status === "ONBOARDING" ? "/onboarding/complete" : "/onboarding";
      } else {
        // Discard the newly created session when application authorization fails.
        const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
        if (signOutError) return { error: "Access was denied. Session cleanup failed; please try signing out again." };
        return {
          error: access.status === "unavailable"
            ? "Unable to verify your profile. Please try again."
            : "Your account does not have active CYCLO access. Contact your administrator.",
        };
      }
    }
  } catch {
    return { error: "Sign-in is temporarily unavailable. Please try again." };
  }

  // Redirect throws internally, so keep it outside the error handler.
  revalidatePath("/", "layout");
  redirect(destination);
}

export async function logout(): Promise<void> {
  const supabase = await createClient();
  // Logout must also work for a session whose profile has just been deactivated.
  // It exposes no data and needs no application role.
  let failed = false;
  try {
    const { error } = await supabase.auth.signOut({ scope: "local" });
    failed = Boolean(error);
  } catch {
    failed = true;
  }
  if (failed) redirect("/login?error=logout_failed");

  revalidatePath("/", "layout");
  redirect("/login");
}
