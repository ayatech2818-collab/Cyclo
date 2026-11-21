import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ClipboardList, CodeXml, GitPullRequest, Orbit, Rocket, ShieldCheck } from "lucide-react";

import { ThemeToggle } from "@/components/theme/theme-toggle";
import { getAccess } from "@/features/auth/access";
import { logout } from "@/features/auth/actions";
import { LoginForm } from "@/features/auth/login-form";
import { createClient } from "@/lib/supabase/server";
import { getThemePreference } from "@/lib/theme/server";

export const metadata: Metadata = { title: "Sign in | CYCLO" };

const messages: Record<string, string> = {
  denied: "Your account does not have active CYCLO access. Contact your administrator.",
  unavailable: "Unable to verify access right now. Please try again.",
  logout_failed: "Sign-out could not be completed. Please try again.",
};

const stages = [
  { icon: ClipboardList, title: "Plan", text: "Shape projects, sprints and priorities with your team." },
  { icon: CodeXml, title: "Build", text: "Track the work as it moves from idea to code." },
  { icon: GitPullRequest, title: "Review", text: "Keep reviews and decisions visible to everyone involved." },
  { icon: Rocket, title: "Deliver", text: "Ship with confidence and a clear record of what changed." },
];

function Logo({ inverted = false }: { inverted?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={inverted
        ? "flex size-9 items-center justify-center rounded-xl bg-white/15 text-white ring-1 ring-white/25"
        : "flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground"}
      >
        <Orbit aria-hidden="true" className="size-5" strokeWidth={2} />
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold tracking-[0.2em]">CYCLO</span>
        <span className={inverted ? "block text-xs text-white/70" : "block text-xs text-text-secondary"}>by AyaTech</span>
      </span>
    </div>
  );
}

export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const supabase = await createClient();
  const [access, { error }, theme] = await Promise.all([getAccess(supabase), searchParams, getThemePreference()]);
  const logoutFailed = error === "logout_failed";
  if (access.status === "authorized" && !logoutFailed) redirect("/dashboard");

  const initialError = typeof error === "string" && Object.hasOwn(messages, error)
    ? messages[error]
    : access.status === "denied" || access.status === "unavailable" ? messages[access.status] : null;

  return (
    <main className="grid min-h-svh lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      {/* Brand panel (desktop) */}
      <section
        aria-label="About CYCLO"
        className="relative hidden overflow-hidden bg-gradient-to-br from-brand-from via-brand-via to-brand-to p-12 text-white lg:flex lg:flex-col lg:justify-between xl:p-16"
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 -right-32 size-[34rem] rounded-full border border-white/10" />
          <div className="absolute -top-16 -right-16 size-[26rem] rounded-full border border-white/10" />
          <div className="absolute top-0 right-0 size-[18rem] rounded-full border border-white/10" />
          <div className="absolute -bottom-40 -left-24 size-[28rem] rounded-full bg-white/10 blur-3xl" />
        </div>

        <div className="relative"><Logo inverted /></div>

        <div className="relative max-w-lg">
          {/* Not a heading: the page's h1 is the sign-in title. */}
          <p className="text-4xl leading-tight font-semibold tracking-tight xl:text-5xl">
            Engineering delivery,<br />from plan to production.
          </p>
          <p className="mt-4 text-base text-white/75">
            One workspace for AyaTech teams to plan, build, review and deliver software together.
          </p>

          <ol className="mt-10 grid gap-5 sm:grid-cols-2">
            {stages.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
                  <Icon aria-hidden="true" className="size-4.5" />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{title}</span>
                  <span className="block text-sm text-white/70">{text}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        <p className="relative text-xs text-white/60">© {new Date().getFullYear()} AyaTech · Internal use only</p>
      </section>

      {/* Sign-in panel */}
      <section aria-labelledby="login-title" className="flex min-h-svh flex-col px-6 py-6 sm:px-10">
        <div className="flex items-center justify-between gap-4 lg:justify-end">
          <div className="lg:hidden"><Logo /></div>
          <ThemeToggle initial={theme} />
        </div>

        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          <h1 id="login-title" className="text-3xl font-semibold tracking-tight">Welcome back</h1>
          <p className="mt-2 text-sm text-text-secondary">Sign in to your CYCLO workspace to continue.</p>

          <div className="mt-8">
            <LoginForm initialError={initialError} />
          </div>

          {(logoutFailed || access.status === "denied" || access.status === "unavailable") && (
            <form action={logout} className="mt-5 text-center">
              <button type="submit" className="text-sm font-medium text-primary underline underline-offset-4 hover:text-primary-hover">
                Clear session and return to sign in
              </button>
            </form>
          )}

          <div className="mt-10 flex items-start gap-2.5 rounded-lg border border-border bg-surface-muted px-3.5 py-3 text-xs text-text-secondary">
            <ShieldCheck aria-hidden="true" className="mt-px size-4 shrink-0 text-text-muted" />
            <p>CYCLO accounts are created by invitation. If you can’t sign in, contact your administrator.</p>
          </div>
        </div>

        <p className="text-center text-xs text-text-muted lg:hidden">© {new Date().getFullYear()} AyaTech · Internal use only</p>
      </section>
    </main>
  );
}
