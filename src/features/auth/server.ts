import "server-only";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { getAccess, type AppRole } from "@/features/auth/access";

/** Call inside every protected page, data operation, and future Server Action. */
export async function requireActiveProfile(allowedRoles?: readonly AppRole[]) {
  const supabase = await createClient();
  const access = await getAccess(supabase);

  if (access.status !== "authorized") {
    const reason = access.status === "anonymous" ? "" : `?error=${access.status}`;
    redirect(`/login${reason}`);
  }

  if (allowedRoles && !allowedRoles.includes(access.profile.role)) {
    // Return no protected data to a caller with insufficient permissions.
    throw new Error("You do not have permission to perform this action.");
  }

  return access;
}
