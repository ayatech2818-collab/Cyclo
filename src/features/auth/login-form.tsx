"use client";

import { useActionState } from "react";

import { login, type AuthFormState } from "@/features/auth/actions";

export function LoginForm({ initialError }: { initialError: string | null }) {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(login, { error: initialError });
  const inputClass = "mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-text-primary disabled:opacity-60";

  return (
    <form action={action} className="mt-8 space-y-5">
      <div>
        <label htmlFor="email" className="text-sm font-medium">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required maxLength={254} disabled={pending} className={inputClass} />
      </div>
      <div>
        <label htmlFor="password" className="text-sm font-medium">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={4096} disabled={pending} className={inputClass} />
      </div>
      <div aria-live="polite" aria-atomic="true">
        {state.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}
      </div>
      <button type="submit" disabled={pending} className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-surface hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
