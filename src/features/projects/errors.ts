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
  // Backlog (Phase 8E)
  | "invalid_position"
  | "invalid_selection"
  | "invalid_bulk_change"
  // Sprints (Phase 8F1)
  | "invalid_sprint_name"
  | "invalid_sprint_goal"
  | "invalid_sprint_dates"
  | "invalid_capacity"
  | "invalid_sprint_transition"
  | "sprint_closed"
  | "sprint_started"
  | "sprint_empty"
  | "active_sprint_exists"
  | "already_in_sprint"
  | "in_another_sprint"
  | "not_in_sprint"
  | "not_schedulable"
  | "unfinished_work_requires_decision"
  | "invalid_carry_over_sprint"
  // Execution (Phase 8F2)
  | "reason_required"
  | "status_changed"
  | "blocked_reason_required"
  | "review_reason_required"
  | "invalid_action"
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
  invalid_position: "That position is no longer available. Reload the backlog and try again.",
  invalid_selection: "Some selected items are no longer in this backlog. Reload and try again.",
  invalid_bulk_change: "Choose a priority or an assignee to apply.",
  invalid_sprint_name: "Enter a sprint name of up to 80 characters.",
  invalid_sprint_goal: "Keep the sprint goal under 2,000 characters.",
  invalid_sprint_dates: "Set a start date that is before the end date.",
  invalid_capacity: "Use a capacity between 0 and 10,000 points, with at most one decimal.",
  invalid_sprint_transition: "This sprint cannot make that change in its current state.",
  sprint_closed: "Completed and cancelled sprints cannot be changed.",
  sprint_started: "The start date of an active sprint cannot change.",
  sprint_empty: "Add at least one work item before starting the sprint.",
  active_sprint_exists: "Another sprint is already active in this project. Complete it first.",
  already_in_sprint: "Some items are already in this sprint.",
  in_another_sprint: "Some items are already in another sprint. Move them from that sprint instead.",
  not_in_sprint: "Some items are no longer in this sprint. Reload and try again.",
  not_schedulable: "Only open stories, tasks and bugs (not archived) can be planned in a sprint.",
  unfinished_work_requires_decision: "Choose where the unfinished work should go.",
  invalid_carry_over_sprint: "Choose a planned sprint of this project for the unfinished work.",
  reason_required: "Add a short reason (3–500 characters).",
  status_changed: "Someone changed this item in the meantime. Its latest status has been loaded.",
  blocked_reason_required: "Use “Mark blocked” and add a reason.",
  review_reason_required: "Use “Request changes” and add a reason.",
  invalid_action: "That action is not available.",
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
  "invalid_position", "invalid_selection", "invalid_bulk_change",
  "invalid_sprint_name", "invalid_sprint_goal", "invalid_sprint_dates", "invalid_capacity", "invalid_sprint_transition",
  "in_another_sprint", "not_in_sprint", "not_schedulable", "unfinished_work_requires_decision", "invalid_carry_over_sprint",
  "reason_required", "blocked_reason_required", "review_reason_required", "invalid_action",
]);

const STATE_MESSAGES = new Set<ProjectErrorCode>([
  "project_archived", "work_item_archived", "parent_archived", "has_active_children", "sprint_closed", "sprint_started",
  "status_changed",
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
      return message === "member_not_found" ? "member_not_found" : "not_found";
    case "23505":
      if (message === "duplicate_member" || message === "active_sprint_exists" || message === "already_in_sprint") return message;
      return "duplicate_project_key";
    case "55000":
      return STATE_MESSAGES.has(message as ProjectErrorCode) ? (message as ProjectErrorCode) : "unexpected";
    case "22023":
      if (message === "invalid_member") return "invalid_member";
      if (message === "sprint_empty") return "sprint_empty";
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
