/*
 * Password recovery rules. Pure and framework-free (unit tested).
 *
 * Recovery emails link to /auth/recovery with either
 *   - token_hash + type=recovery   (email template link; works from any browser), or
 *   - code                         (PKCE redirect after resetPasswordForEmail in the same browser).
 * The callback verifies the link with Supabase Auth, which creates a short-lived
 * session, and sends the browser to /reset-password.
 *
 * /reset-password only accepts a session that was created from an email link
 * moments ago (signed `amr` claim "otp" or "recovery" within RECOVERY_WINDOW_SECONDS).
 * An ordinary password-login session cannot use it, so a stolen or unattended
 * signed-in browser cannot silently change the password through this page.
 */

export const RECOVERY_WINDOW_SECONDS = 15 * 60;

export type RecoveryCallback = { kind: "token_hash"; tokenHash: string } | { kind: "code"; code: string };

const TOKEN_HASH = /^[A-Za-z0-9_-]{20,256}$/;
const PKCE_CODE = /^[A-Za-z0-9_-]{8,512}$/;

/** Parses the recovery callback query; anything ambiguous or malformed is rejected. */
export function parseRecoveryCallback(params: URLSearchParams): RecoveryCallback | null {
  const hashes = params.getAll("token_hash");
  const types = params.getAll("type");
  const codes = params.getAll("code");
  if (hashes.length > 1 || types.length > 1 || codes.length > 1) return null;
  if (hashes.length === 1 && codes.length === 0) {
    if (types[0] !== "recovery" || !TOKEN_HASH.test(hashes[0])) return null;
    return { kind: "token_hash", tokenHash: hashes[0] };
  }
  if (codes.length === 1 && hashes.length === 0) {
    // A PKCE redirect carries no type, or type=recovery; nothing else.
    if (types.length === 1 && types[0] !== "recovery") return null;
    if (!PKCE_CODE.test(codes[0])) return null;
    return { kind: "code", code: codes[0] };
  }
  return null;
}

type AmrEntry = { method?: unknown; timestamp?: unknown };

/** True when the verified JWT claims show an email-link sign-in within the recovery window. */
export function isRecentEmailLinkSession(claims: unknown, nowSeconds: number): boolean {
  if (typeof claims !== "object" || claims === null) return false;
  const amr = (claims as { amr?: unknown }).amr;
  if (!Array.isArray(amr)) return false;
  return amr.some((entry: AmrEntry) =>
    (entry?.method === "otp" || entry?.method === "recovery")
    && typeof entry.timestamp === "number"
    && entry.timestamp <= nowSeconds + 60
    && nowSeconds - entry.timestamp <= RECOVERY_WINDOW_SECONDS);
}

/** Maps Supabase Auth updateUser errors to safe messages (no raw Auth text). */
export function passwordUpdateError(error: { code?: string | null; status?: number | null } | null | undefined): string {
  switch (error?.code) {
    case "same_password":
      return "Choose a password that is different from your current one.";
    case "weak_password":
      return "This password is too weak or has appeared in a data breach. Choose a different one.";
    case "reauthentication_needed":
    case "session_expired":
    case "session_not_found":
      return "Your reset link has expired. Request a new password-reset email.";
    default:
      return error?.status === 429
        ? "Too many attempts. Please wait a moment and try again."
        : "The password could not be updated. Please try again.";
  }
}
