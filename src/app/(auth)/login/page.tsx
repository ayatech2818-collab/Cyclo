import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getAccess } from "@/features/auth/access";
import { logout } from "@/features/auth/actions";
import { LoginForm } from "@/features/auth/login-form";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Sign in | CYCLO" };

const messages: Record<string, string> = {
  denied: "Your account does not have active CYCLO access. Contact your administrator.",
  unavailable: "Unable to verify access right now. Please try again.",
  logout_failed: "Sign-out could not be completed. Please try again.",
};

export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const supabase = await createClient();
  const access = await getAccess(supabase);
  const { error } = await searchParams;
  const logoutFailed = error === "logout_failed";
  if (access.status === "authorized" && !logoutFailed) redirect("/dashboard");

  const initialError = typeof error === "string" && Object.hasOwn(messages, error)
    ? messages[error]
    : access.status === "denied" || access.status === "unavailable" ? messages[access.status] : null;

  return (
    <main className="flex min-h-svh items-center justify-center px-6 py-12">
      <section aria-labelledby="login-title" className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-10">
        <p className="text-sm font-semibold tracking-widest text-primary">CYCLO</p>
        <h1 id="login-title" className="mt-4 text-2xl font-semibold tracking-tight">Sign in to CYCLO</h1>
        <p className="mt-2 text-sm text-text-secondary">Engineering Delivery Management</p>
        <LoginForm initialError={initialError} />
        {(logoutFailed || access.status === "denied" || access.status === "unavailable") && (
          <form action={logout} className="mt-5">
            <button type="submit" className="text-sm font-medium text-primary underline underline-offset-4">Clear session and return to sign in</button>
          </form>
        )}
      </section>
    </main>
  );
}
