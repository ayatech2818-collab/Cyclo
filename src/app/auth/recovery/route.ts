import { NextResponse, type NextRequest } from "next/server";

import { parseRecoveryCallback } from "@/features/auth/recovery";
import { createClient } from "@/lib/supabase/server";

/**
 * Password-recovery callback. Accepts only a Supabase recovery token hash or a
 * PKCE code; there is no arbitrary `next` redirect. On success the recovery
 * session cookies are written and the browser goes to /reset-password.
 */
export async function GET(request: NextRequest) {
  const link = parseRecoveryCallback(request.nextUrl.searchParams);
  let destination = "/login?error=recovery_invalid";

  if (link) {
    const client = await createClient();
    const { error } = link.kind === "token_hash"
      ? await client.auth.verifyOtp({ token_hash: link.tokenHash, type: "recovery" })
      : await client.auth.exchangeCodeForSession(link.code);
    if (!error) destination = "/reset-password";
  }

  // Host-relative Location: the session cookie stays on the host the link used.
  const response = new NextResponse(null, { status: 303, headers: { Location: destination } });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
