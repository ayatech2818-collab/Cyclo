import type { ReactNode } from "react";
import { KeyRound } from "lucide-react";

/** Centered card used by the password recovery pages. */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-10">
      <section aria-labelledby="auth-card-title" className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
        <div className="mb-5 flex items-center gap-2 text-sm font-semibold tracking-widest text-primary">
          <KeyRound aria-hidden="true" className="size-4" />
          CYCLO
        </div>
        <h1 id="auth-card-title" className="text-2xl font-semibold tracking-tight">{title}</h1>
        {children}
      </section>
    </main>
  );
}
