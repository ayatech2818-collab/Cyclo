import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/features/auth/auth-card";
import { getRecoverySession } from "@/features/auth/recovery.server";
import { ResetPasswordForm } from "@/features/auth/reset-password-form";

export const metadata: Metadata = { title: "Reset password | CYCLO" };

/**
 * Reached from /auth/recovery. Requires a signed session created from an email
 * link within the recovery window; otherwise it only explains what to do.
 */
export default async function ResetPasswordPage() {
  const session = await getRecoverySession();

  if (!session) {
    return (
      <AuthCard title="Set a new password">
        <p role="alert" className="mt-3 text-sm text-text-secondary">
          This page needs a fresh password-reset link. Reset links work once and must be used soon after they are opened.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <Link href="/forgot-password" className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">
            Request a new link
          </Link>
          <Link href="/login" className="text-sm font-medium text-primary underline underline-offset-4">Back to sign in</Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Set a new password">
      <p className="mt-2 text-sm text-text-secondary">
        {session.email ? <>Choose a new password for <span className="font-medium text-text-primary">{session.email}</span>.</> : "Choose a new password for your account."}{" "}
        You will be signed out everywhere and can then sign in with it.
      </p>
      <div className="mt-6"><ResetPasswordForm /></div>
    </AuthCard>
  );
}
