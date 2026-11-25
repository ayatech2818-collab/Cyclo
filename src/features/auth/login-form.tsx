"use client";

import Link from "next/link";
import { ArrowRight, CircleAlert, Eye, EyeOff, LoaderCircle, Lock, Mail } from "lucide-react";
import { useActionState, useState, type KeyboardEvent } from "react";

import { login, type AuthFormState } from "@/features/auth/actions";

const field =
  "h-11 w-full rounded-lg border border-border bg-surface pl-10 text-sm text-text-primary shadow-sm transition-colors " +
  "hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/15 " +
  "disabled:cursor-not-allowed disabled:opacity-60";
const fieldIcon = "pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-text-muted";

export function LoginForm({ initialError }: { initialError: string | null }) {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(login, { error: initialError });
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  const trackCapsLock = (event: KeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState("CapsLock"));

  return (
    // key: remount after each attempt so the echoed email becomes the input's default value.
    <form key={state.email ?? ""} action={action} className="space-y-5">
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium">Work email</label>
        <div className="relative">
          <Mail aria-hidden="true" className={fieldIcon} />
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            maxLength={254}
            disabled={pending}
            defaultValue={state.email}
            placeholder="name@ayatech.com"
            className={`${field} pr-3`}
          />
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <label htmlFor="password" className="block text-sm font-medium">Password</label>
          <Link href="/forgot-password" className="text-sm font-medium text-primary underline-offset-4 hover:text-primary-hover hover:underline">
            Forgot password?
          </Link>
        </div>
        <div className="relative">
          <Lock aria-hidden="true" className={fieldIcon} />
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            maxLength={4096}
            disabled={pending}
            autoFocus={Boolean(state.email)}
            onKeyUp={trackCapsLock}
            onKeyDown={trackCapsLock}
            onBlur={() => setCapsLock(false)}
            aria-describedby={capsLock ? "caps-lock-hint" : undefined}
            className={`${field} pr-11`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            aria-controls="password"
            disabled={pending}
            className="absolute top-1/2 right-1.5 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-text-muted hover:bg-surface-muted hover:text-text-primary disabled:opacity-60"
          >
            {showPassword ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
          </button>
        </div>
        {capsLock && <p id="caps-lock-hint" className="mt-1.5 text-xs font-medium text-warning">Caps Lock is on.</p>}
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
        disabled={pending}
        className="group inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary-hover disabled:cursor-wait disabled:opacity-70"
      >
        {pending ? (
          <>
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            Signing in…
          </>
        ) : (
          <>
            Sign in
            <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
          </>
        )}
      </button>
    </form>
  );
}
