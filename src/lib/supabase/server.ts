import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/types/database";

import { getSupabaseEnv } from "./env";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * Create a new client per request (never share one across requests).
 * For authorization decisions use `supabase.auth.getClaims()`, which verifies
 * the JWT, rather than `getSession()`, which reads cookies without verifying.
 */
export async function createClient() {
  const { url, publishableKey } = getSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Cookies are read-only in Server Components. This is safe to
          // ignore because the proxy (src/proxy.ts) refreshes the session
          // and writes updated cookies on every matched request.
        }
      },
    },
  });
}
