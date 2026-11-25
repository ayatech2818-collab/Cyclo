import "server-only";

import { notFound, redirect } from "next/navigation";

import { ProjectError, type ProjectErrorCode } from "./errors";

export type PageErrorCode = Exclude<ProjectErrorCode, "forbidden" | "not_found" | "unauthenticated">;

/**
 * Runs a project query for a page. Authorization failures become a 404 (the
 * project's existence is not disclosed) or a sign-in redirect; recoverable
 * failures are returned for an inline error state. Anything else is rethrown.
 */
export async function loadProjectForPage<T>(load: () => Promise<T>): Promise<{ data: T; error: null } | { data: null; error: PageErrorCode }> {
  try {
    return { data: await load(), error: null };
  } catch (error) {
    if (!(error instanceof ProjectError)) throw error;
    if (error.code === "forbidden" || error.code === "not_found") notFound();
    if (error.code === "unauthenticated") redirect("/login");
    return { data: null, error: error.code };
  }
}
