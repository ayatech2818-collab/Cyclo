import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseEnv } from "./env";

/**
 * Refreshes the Supabase session on every matched request.
 *
 * getClaims() validates the access token's JWT signature and, when the token
 * has expired, uses the refresh token to obtain a new one. Refreshed cookies
 * are written to both the incoming request (so Server Components rendered in
 * this request see them) and the outgoing response (so the browser stores
 * them).
 *
 * No redirects happen here yet; route protection is a later phase.
 */
export async function updateSession(request: NextRequest) {
  const { url, publishableKey } = getSupabaseEnv();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
        // Cache-control headers that stop CDNs from caching responses
        // carrying a user's auth cookies.
        Object.entries(headers).forEach(([key, value]) =>
          response.headers.set(key, value),
        );
      },
    },
  });

  // Do not run code between createServerClient and getClaims(): it can make
  // session refresh bugs very hard to trace.
  await supabase.auth.getClaims();

  // Return this exact response object. If a new response is ever created,
  // copy over response.cookies, or the browser and server sessions will
  // drift and users may be signed out unexpectedly.
  return response;
}
