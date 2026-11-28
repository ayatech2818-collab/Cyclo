"use client";

import Link from "next/link";
import { ArrowLeft, CircleAlert, LoaderCircle, Mail, MailCheck } from "lucide-react";
import { useActionState, useState } from "react";

import { requestPasswordReset, type ForgotPasswordState } from "./recovery-actions";

const field =
  "h-11 w-full rounded-lg border border-border bg-surface pl-10 pr-3 text-sm text-text-primary shadow-sm transition-colors " +
  "hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/15 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export const NEUTRAL_RESET_MESSAGE = "If an account exists for this email, you will receive a password reset link.";

const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) && value.trim().length <= 254;

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState<ForgotPasswordState, FormData>(requestPasswordReset, { sent: false, error: null });
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const invalid = touched && email.length > 0 && !looksLikeEmail(email);

  const back = (
    <Link href="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline">
      <ArrowLeft aria-hidden="true" className="size-4" />
      Back to sign in
    </Link>
  );

  if (state.sent) {
    return (
      <div className="mt-6 space-y-6">
        <div role="status" className="flex gap-3 rounded-lg border border-success/25 bg-success/10 px-4 py-3 text-sm text-success">
          <MailCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">{NEUTRAL_RESET_MESSAGE}</p>
            <p className="mt-1 text-text-secondary">The link works once and expires after one hour. Check your spam folder if it does not arrive within a few minutes.</p>
          </div>
        </div>
        {back}
      </div>
    );
  }

  return (
    <form action={action} className="mt-6 space-y-5" aria-busy={pending} noValidate>
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium">Work email</label>
        <div className="relative">
          <Mail aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-text-muted" />
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            maxLength={254}
            disabled={pending}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="name@ayatech.com"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? "email-hint" : undefined}
            className={field}
          />
        </div>
        {invalid && <p id="email-hint" className="mt-1.5 text-xs text-warning">Enter a valid email address.</p>}
      </div>

      <div aria-live="polite" aria-atomic="true">
        {state.error && (
          <div role="alert" className="flex gap-2.5 rounded-lg border border-danger/25 bg-danger/10 px-3.5 py-3 text-sm text-danger">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>{state.error}</p>
          </div>
        )}
      </div>

      <button
        type="submit"
        disabled={pending || !looksLikeEmail(email)}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-action px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? <><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Sending…</> : "Send reset link"}
      </button>

      <div className="text-center">{back}</div>
    </form>
  );
}
