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
  | "invalid_member"
  | "duplicate_member"
  | "member_not_found"
  // Work items (Phase 8D)
  | "invalid_type"
  | "invalid_title"
  | "invalid_parent"
  | "invalid_assignee"
  | "invalid_estimate"
  | "invalid_transition"
  | "work_item_archived"
  | "parent_archived"
  | "has_active_children"
  | "unavailable"
  | "unexpected";

export const PROJECT_ERROR_MESSAGES: Record<ProjectErrorCode, string> = {
  unauthenticated: "Your session has expired. Please sign in again.",
  forbidden: "You do not have permission to perform this operation.",
  not_found: "Project not found.",
  invalid_input: "The request contained invalid values.",
  invalid_name: "Use 2–120 characters without line breaks.",
  invalid_project_key: "Use 2–10 letters or digits, starting with a letter.",
  invalid_description: "The description is too long.",
  invalid_priority: "Choose a priority.",
  invalid_status: "Choose a status.",
  invalid_date_range: "The end date must be on or after the start date.",
  invalid_project_manager: "Choose an active Project Manager.",
  duplicate_project_key: "This project key is already in use. Choose another key.",
  project_archived: "Archived projects are read-only. Restore the project to make changes.",
  invalid_member: "Only active developers can be added to a project team.",
  duplicate_member: "This developer is already on the team.",
  member_not_found: "This developer is no longer on the team.",
  invalid_type: "This type does not fit the item's parent or children.",
  invalid_title: "Enter a title of up to 255 characters, without line breaks.",
  invalid_parent: "That parent is not allowed for this type of work item.",
  invalid_assignee: "Only active developers on this project's team can be assigned.",
  invalid_estimate: "Use an estimate between 0 and 1000, with at most one decimal.",
  invalid_transition: "That status change is not allowed from the current status.",
  work_item_archived: "Archived work items are read-only. Restore it to make changes.",
  parent_archived: "The parent work item is archived.",
  has_active_children: "Archive or move this item's children first.",
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
  "invalid_type", "invalid_title", "invalid_parent", "invalid_assignee", "invalid_estimate", "invalid_transition",
]);

const STATE_MESSAGES = new Set<ProjectErrorCode>(["project_archived", "work_item_archived", "parent_archived", "has_active_children"]);

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
      return message === "member_not_found" ? "member_not_found" : "not_found";
    case "23505":
      return message === "duplicate_member" ? "duplicate_member" : "duplicate_project_key";
    case "55000":
      return STATE_MESSAGES.has(message as ProjectErrorCode) ? (message as ProjectErrorCode) : "unexpected";
    case "22023":
      if (message === "invalid_member") return "invalid_member";
      return VALIDATION_MESSAGES.has(message as ProjectErrorCode) ? (message as ProjectErrorCode) : "invalid_input";
    case "23514":
      if (message === "invalid_project_manager") return "invalid_project_manager";
      if (message === "invalid_member") return "invalid_member";
      return "invalid_input";
    case "23503": // foreign key (e.g. a parent from another project)
      return "invalid_parent";
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
