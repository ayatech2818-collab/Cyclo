import { createBrowserClient } from "@supabase/ssr";

import { getSupabaseEnv } from "./env";

/**
 * Supabase client for Client Components (browser only).
 *
 * createBrowserClient already returns a singleton in the browser, so calling
 * this function wherever a client is needed is cheap. Session state read here
 * is for UI purposes only and must never be trusted for authorization.
 */
export function createClient() {
  const { url, publishableKey } = getSupabaseEnv();

  return createBrowserClient(url, publishableKey);
}
