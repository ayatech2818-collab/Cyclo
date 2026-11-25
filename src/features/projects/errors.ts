import type { ProjectField } from "./types";

/**
 * Application-level error codes for project operations. Database errors are
 * mapped to these codes so raw SQL messages never reach the UI.
 */
export type ProjectErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "invalid_name"
  | "invalid_project_key"
  | "invalid_description"
  | "invalid_priority"
  | "invalid_status"
  | "invalid_date_range"
  | "invalid_project_manager"
  | "duplicate_project_key"
  | "project_archived"
  | "unavailable"
  | "unexpected";

export const PROJECT_ERROR_MESSAGES: Record<ProjectErrorCode, string> = {
  unauthenticated: "Your session has expired. Please sign in again.",
  forbidden: "You do not have permission to perform this operation.",
  not_found: "Project not found.",
  invalid_input: "The request contained invalid values.",
  invalid_name: "Use 2–120 characters without line breaks.",
  invalid_project_key: "Use 2–10 letters or digits, starting with a letter.",
  invalid_description: "Keep the description under 5,000 characters.",
  invalid_priority: "Choose a priority.",
  invalid_status: "Choose a status.",
  invalid_date_range: "Target date must be on or after the start date.",
  invalid_project_manager: "Choose an active Project Manager.",
  duplicate_project_key: "This project key is already in use. Choose another key.",
  project_archived: "Archived projects are read-only. Restore the project to make changes.",
  unavailable: "Project data is temporarily unavailable. Please try again.",
  unexpected: "Something went wrong. Please try again.",
};

/** Form field that a validation error belongs to, if any. */
export const PROJECT_ERROR_FIELDS: Partial<Record<ProjectErrorCode, ProjectField>> = {
  invalid_name: "name",
  invalid_project_key: "projectKey",
  duplicate_project_key: "projectKey",
  invalid_description: "description",
  invalid_priority: "priority",
  invalid_status: "status",
  invalid_date_range: "targetDate",
  invalid_project_manager: "projectManagerId",
};

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;

  constructor(code: ProjectErrorCode) {
    super(PROJECT_ERROR_MESSAGES[code]);
    this.name = "ProjectError";
    this.code = code;
  }
}

type DatabaseErrorLike = { code?: string | null; message?: string | null };

const VALIDATION_MESSAGES = new Set<ProjectErrorCode>([
  "invalid_name", "invalid_project_key", "invalid_description", "invalid_priority",
  "invalid_status", "invalid_date_range", "invalid_project_manager",
]);

const MISSING_FUNCTION_CODES = new Set(["PGRST202", "42883"]);

/** One-line server diagnostic: operation and SQLSTATE only, never input or raw messages. */
export function describeProjectFailure(operation: string, error: DatabaseErrorLike | null | undefined): string {
  const code = error?.code || "unknown";
  const hint = MISSING_FUNCTION_CODES.has(code)
    ? " (database function not found: apply the project migration to the database this app is connected to)"
    : "";
  return `[projects] ${operation} failed: code=${code}${hint}`;
}

/** Maps a PostgREST/Postgres error from the project RPCs to a safe application code. */
export function mapProjectDatabaseError(error: DatabaseErrorLike | null | undefined): ProjectErrorCode {
  if (!error) return "unexpected";
  const message = error.message ?? "";
  switch (error.code) {
    case "42501":
      return message === "unauthenticated" ? "unauthenticated" : "forbidden";
    case "P0002":
      return "not_found";
    case "23505":
      return "duplicate_project_key";
    case "55000":
      return message === "project_archived" ? "project_archived" : "unexpected";
    case "22023":
      return VALIDATION_MESSAGES.has(message as ProjectErrorCode) ? (message as ProjectErrorCode) : "invalid_input";
    case "23514":
      if (message === "invalid_project_manager") return "invalid_project_manager";
      return "invalid_input";
    case "22P02": // invalid enum/uuid/date text representation
    case "22007":
    case "22008":
      return "invalid_input";
    case "PGRST301":
    case "PGRST302":
      return "unauthenticated";
    case "PGRST202":
    case "42883":
    case "08000":
    case "08003":
    case "08006":
    case "57P01":
    case "57P03":
    case "53300":
      return "unavailable";
    default:
      return "unexpected";
  }
}
