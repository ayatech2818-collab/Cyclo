import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAccess } from "@/features/auth/access";
import { invitationRpc } from "./operations.server";

export async function requireOnboarding() {
  const client = await createClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) redirect("/login");
  const [invitation] = await invitationRpc("get_my_employee_invitation", {});
  if (!invitation) {
    const access = await getAccess(client);
    redirect(access.status === "authorized" ? "/dashboard" : "/login?error=invitation_invalid");
  }
  if (invitation.status === "COMPLETED") redirect("/dashboard");
  return { client, invitation };
}
