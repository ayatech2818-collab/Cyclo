import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./env";
import type { Database } from "@/types/database";

/** Auth Admin only. Never use this client for ordinary profile/RPC mutations. */
export function createAuthAdminClient() {
  const { url } = getSupabaseEnv();
  // Phase 5 has local-only deployment authorization.
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) throw new Error("Invitation administration is currently enabled for local Supabase only.");
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret || (!secret.startsWith("sb_secret_") && secret.split(".").length !== 3)) throw new Error("Configure server-only SUPABASE_SECRET_KEY for local Auth Admin.");
  return createClient<Database>(url, secret, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

export function invitationCallbackUrl(): string {
  const url = new URL(process.env.CYCLO_APP_URL ?? "http://127.0.0.1:3000");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Configure CYCLO_APP_URL as the local application origin.");
  return `${url.origin}/auth/confirm`;
}
