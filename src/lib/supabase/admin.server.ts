import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./env";
import { isAcceptableSecretKey, resolveInvitationTargets } from "./invitation-origins";
import type { Database } from "@/types/database";

/*
 * Auth Admin only (invitation and resume emails). Never use this client for
 * ordinary profile/RPC mutations. Targets are validated on every call: a local
 * Supabase stack with a local app origin, or a hosted Supabase project with an
 * explicitly configured https production origin (see invitation-origins.ts).
 */

/** Auth Admin client for the validated Supabase project. */
export function createAuthAdminClient() {
  const { url } = getSupabaseEnv();
  const targets = resolveInvitationTargets(url, process.env.CYCLO_APP_URL);
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!isAcceptableSecretKey(secret, targets.mode)) {
    throw new Error("Configure the server-only SUPABASE_SECRET_KEY for Auth Admin.");
  }
  return createClient<Database>(targets.supabaseOrigin, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Exact Auth redirect target for invitation and resume emails: `<app origin>/auth/confirm`. */
export function invitationCallbackUrl(): string {
  const { url } = getSupabaseEnv();
  return resolveInvitationTargets(url, process.env.CYCLO_APP_URL).callbackUrl;
}
