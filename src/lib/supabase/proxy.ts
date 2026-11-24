import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getAccess } from "@/features/auth/access";

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
 * Application routes are protected by default; only / and /login are public.
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

  const pathname = request.nextUrl.pathname;
  if (pathname === "/") return response;
  // Callback verifies its one-time token. Onboarding pages/actions independently
  // verify Auth identity plus the caller's own invitation, including expiry.
  if (["/auth/confirm", "/onboarding", "/onboarding/complete"].includes(pathname)) {
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }

  const access = await getAccess(supabase);
  response.headers.set("Cache-Control", "private, no-store");

  let destination: URL | null = null;
  if (pathname === "/login") {
    // Leave a failed logout visible so the user can retry without a redirect loop.
    if (access.status === "authorized" && request.nextUrl.searchParams.get("error") !== "logout_failed") {
      destination = new URL("/dashboard", request.url);
    }
  } else if (access.status !== "authorized") {
    destination = new URL("/login", request.url);
    if (access.status !== "anonymous") destination.searchParams.set("error", access.status);
  }

  if (destination) {
    const redirect = NextResponse.redirect(destination, 303);
    // Keep refreshed/deleted auth cookies AND the SSR cache-control headers.
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    for (const name of ["Cache-Control", "Pragma", "Expires", "Vary"]) {
      const value = response.headers.get(name);
      if (value) redirect.headers.set(name, value);
    }
    return redirect;
  }

  // Return this exact response object. If a new response is ever created,
  // copy over response.cookies, or the browser and server sessions will
  // drift and users may be signed out unexpectedly.
  return response;
}
