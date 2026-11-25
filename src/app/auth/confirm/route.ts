import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Only Supabase-generated invite token hashes are accepted. No arbitrary next URL. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  let destination = "/login?error=invitation_invalid";
  if (params.getAll("token_hash").length === 1 && params.getAll("type").length === 1 && (type === "invite" || type === "email") && tokenHash && /^[A-Za-z0-9_-]{20,256}$/.test(tokenHash)) {
    const client = await createClient();
    const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) {
      const own = await client.rpc("get_my_employee_invitation");
      const invitation = own.error ? null : own.data?.[0];
      if (invitation?.status === "PENDING") {
        const accepted = await client.rpc("accept_employee_invitation");
        if (!accepted.error) destination = "/onboarding";
      } else if (invitation?.status === "ACCEPTED" || invitation?.status === "ONBOARDING") {
        // A newly verified resume token restores a session; it does not replay
        // the invitation acceptance transition or change its assigned role.
        destination = invitation.status === "ONBOARDING" ? "/onboarding/complete" : "/onboarding";
      }
      if (destination.startsWith("/login")) await client.auth.signOut({ scope: "local" });
    }
  }
  // A relative Location keeps the browser on the host it used for this request.
  // request.url can name a different host (next dev reports "localhost" for
  // 127.0.0.1), and the session cookie just written would not follow it.
  const response = new NextResponse(null, { status: 303, headers: { Location: destination } });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
