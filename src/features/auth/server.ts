import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { getAccess, type AccessResult, type AppRole } from "@/features/auth/access";

/**
 * Verified access for the current server request.
 *
 * React `cache` scopes the result to a single request, so the layouts, pages,
 * metadata and queries rendered for one request share one Auth `getUser()`
 * call and one profile read. Nothing is shared between requests: deactivation
 * still takes effect on the next request.
 */
export const getRequestAccess = cache(async (): Promise<AccessResult> => getAccess(await createClient()));

/** Call inside every protected page, data operation, and future Server Action. */
export async function requireActiveProfile(allowedRoles?: readonly AppRole[]) {
  const access = await getRequestAccess();

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
