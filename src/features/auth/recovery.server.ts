import "server-only";

import { getSupabaseEnv } from "@/lib/supabase/env";
import { resolveInvitationTargets } from "@/lib/supabase/invitation-origins";
import { createClient } from "@/lib/supabase/server";

import { isRecentEmailLinkSession } from "./recovery";

/**
 * The caller's recovery session, or null. getClaims verifies the JWT signature
 * (refreshing an expired access token first); only a session created from an
 * email link within the recovery window qualifies.
 */
export async function getRecoverySession() {
  const client = await createClient();
  const { data, error } = await client.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims || !isRecentEmailLinkSession(claims, Math.floor(Date.now() / 1000))) return null;
  return { client, email: typeof claims.email === "string" ? claims.email : null };
}

/**
 * `<app origin>/auth/recovery` from the same strictly validated configuration as
 * invitations (local loopback pairing, or https production origin with a hosted
 * project). Never derived from request headers. Returns null when the pairing is
 * not valid (for example a local dev server against the hosted project); Supabase
 * then falls back to the project's Site URL, which the email template uses anyway.
 */
export function recoveryRedirectUrl(): string | null {
  try {
    return `${resolveInvitationTargets(getSupabaseEnv().url, process.env.CYCLO_APP_URL).appOrigin}/auth/recovery`;
  } catch {
    return null;
  }
}
