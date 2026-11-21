import "server-only";

import { notFound, redirect } from "next/navigation";

import { EmployeeError, type EmployeeErrorCode } from "./errors";

/**
 * Runs an employee query for a page. Authorization failures become a 404
 * (the page's existence is not disclosed to unauthorized roles) or a sign-in
 * redirect. Recoverable failures are returned so the page can render an
 * inline error state. Anything else (including Next.js redirects) is rethrown.
 */
export async function loadForPage<T>(
  load: () => Promise<T>,
): Promise<{ data: T; error: null } | { data: null; error: Exclude<EmployeeErrorCode, "forbidden" | "not_found" | "unauthenticated"> }> {
  try {
    return { data: await load(), error: null };
  } catch (error) {
    if (!(error instanceof EmployeeError)) throw error;
    if (error.code === "forbidden" || error.code === "not_found") notFound();
    if (error.code === "unauthenticated") redirect("/login");
    return { data: null, error: error.code };
  }
}
