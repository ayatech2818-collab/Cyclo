"use client";

import { Check, CircleAlert, Eye, EyeOff, LoaderCircle, Lock, X } from "lucide-react";
import { useActionState, useState } from "react";

import { cn } from "@/lib/utils/cn";

import { resetPassword, type ResetPasswordState } from "./recovery-actions";

const field =
  "h-11 w-full rounded-lg border border-border bg-surface pl-10 pr-11 text-sm text-text-primary shadow-sm transition-colors " +
  "hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/15 " +
  "disabled:cursor-not-allowed disabled:opacity-60";
const fieldIcon = "pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-text-muted";

/** Matches the server rule (validateOnboardingPassword) and Supabase/bcrypt's 72-byte limit. */
export const MIN_LENGTH = 12;
export const MAX_BYTES = 72;

const byteLength = (value: string) => new TextEncoder().encode(value).length;

export function passwordChecks(password: string, confirmation: string) {
  return {
    length: password.length >= MIN_LENGTH,
    bytes: password.length > 0 && byteLength(password) <= MAX_BYTES,
    match: password.length > 0 && password === confirmation,
  };
}

/** Advisory only: 0 weak … 3 strong. The rules above are what the server enforces. */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 {
  if (password.length < MIN_LENGTH) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const repetitive = /(.)\1{3,}/.test(password) || new Set(password).size < 6;
  let score = 1;
  if (password.length >= 16 || classes >= 3) score++;
  if (password.length >= 16 && classes >= 3) score++;
  if (repetitive) score = Math.max(1, score - 1);
  return score as 1 | 2 | 3;
}

const strengthLabels = ["Too short", "Weak", "Good", "Strong"] as const;
const strengthColors = ["bg-border", "bg-danger", "bg-warning", "bg-success"] as const;

function Rule({ ok, children }: { ok: boolean; children: string }) {
  const Icon = ok ? Check : X;
  return (
    <li className={cn("flex items-center gap-1.5", ok ? "text-success" : "text-text-secondary")}>
      <Icon aria-hidden="true" className="size-3.5" />
      <span>{children}</span>
      <span className="sr-only">{ok ? "(met)" : "(not met)"}</span>
    </li>
  );
}

export function ResetPasswordForm() {
  const [state, action, pending] = useActionState<ResetPasswordState, FormData>(resetPassword, { error: null });
  const [show, setShow] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const checks = passwordChecks(password, confirmation);
  const ready = checks.length && checks.bytes && checks.match;
  const strength = passwordStrength(password);

  const input = (id: "password" | "confirmation", label: string, value: string, onChange: (v: string) => void) => (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}</label>
      <div className="relative">
        <Lock aria-hidden="true" className={fieldIcon} />
        <input
          id={id}
          name={id}
          type={show ? "text" : "password"}
          autoComplete="new-password"
          required
          minLength={MIN_LENGTH}
          maxLength={MAX_BYTES}
          disabled={pending}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby="password-rules"
          className={field}
        />
        {id === "password" && (
          <button
            type="button"
            onClick={() => setShow((current) => !current)}
            aria-label={show ? "Hide passwords" : "Show passwords"}
            aria-pressed={show}
            disabled={pending}
            className="absolute top-1/2 right-1.5 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-text-muted hover:bg-surface-muted hover:text-text-primary disabled:opacity-60"
          >
            {show ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <form action={action} className="space-y-5" aria-busy={pending}>
      {input("password", "New password", password, setPassword)}

      {password && (
        <div aria-live="polite">
          <div className="flex gap-1" aria-hidden="true">
            {[1, 2, 3].map((level) => (
              <span key={level} className={cn("h-1.5 flex-1 rounded-full", strength >= level ? strengthColors[strength] : "bg-border")} />
            ))}
          </div>
          <p className="mt-1 text-xs text-text-secondary">Strength: <span className="font-medium text-text-primary">{strengthLabels[strength]}</span></p>
        </div>
      )}

      {input("confirmation", "Confirm new password", confirmation, setConfirmation)}

      <ul id="password-rules" className="space-y-1 text-xs" aria-label="Password requirements">
        <Rule ok={checks.length}>{`At least ${MIN_LENGTH} characters`}</Rule>
        <Rule ok={checks.bytes}>{`At most ${MAX_BYTES} bytes (emoji and accents count more)`}</Rule>
        <Rule ok={checks.match}>Both passwords match</Rule>
      </ul>

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
        disabled={pending || !ready}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-action px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? <><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Updating password…</> : "Update password"}
      </button>
    </form>
  );
}
