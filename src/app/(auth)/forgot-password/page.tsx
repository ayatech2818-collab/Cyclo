import type { Metadata } from "next";

import { AuthCard } from "@/features/auth/auth-card";
import { ForgotPasswordForm } from "@/features/auth/forgot-password-form";

export const metadata: Metadata = { title: "Forgot password | CYCLO" };

/** Public page: requests a recovery email without revealing whether the account exists. */
export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Forgot your password?">
      <p className="mt-2 text-sm text-text-secondary">Enter your work email and we will send you a link to set a new password.</p>
      <ForgotPasswordForm />
    </AuthCard>
  );
}
