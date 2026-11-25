import type { AppRole } from "@/features/auth/access";

/** Mirrors public.project_status (order = lifecycle order). */
export const PROJECT_STATUSES = ["planning", "active", "on_hold", "completed", "cancelled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Mirrors public.project_priority (ascending). */
export const PROJECT_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type ProjectPriority = (typeof PROJECT_PRIORITIES)[number];

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: "Planning",
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const PRIORITY_LABELS: Record<ProjectPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

/** Allow-listed sort keys; must match private.list_projects. */
export const PROJECT_SORTS = ["updated_desc", "created_desc", "created_asc", "name_asc", "name_desc", "target_asc", "priority_desc"] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];

export const SORT_LABELS: Record<ProjectSort, string> = {
  updated_desc: "Recently updated",
  created_desc: "Newest first",
  created_asc: "Oldest first",
  name_asc: "Name A–Z",
  name_desc: "Name Z–A",
  target_asc: "Target date",
  priority_desc: "Priority",
};

export type ProjectView = "grid" | "list";

/** Roles that may create projects. Enforced again in the database. */
export const PROJECT_CREATOR_ROLES = ["SUPER_ADMIN", "PROJECT_MANAGER"] as const satisfies readonly AppRole[];

export type ProjectListQuery = {
  search: string;
  status: ProjectStatus | null;
  priority: ProjectPriority | null;
  archived: boolean;
  sort: ProjectSort;
  view: ProjectView;
  page: number;
  pageSize: number;
};

export type ProjectListItem = {
  id: string;
  name: string;
  projectKey: string;
  description: string | null;
  status: ProjectStatus;
  priority: ProjectPriority;
  projectManagerId: string;
  projectManagerName: string | null;
  startDate: string | null;
  targetDate: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type ProjectListPage = {
  items: ProjectListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export type ProjectDetail = ProjectListItem & {
  projectManagerEmail: string | null;
  /** False when the assigned PM was later deactivated or changed role. */
  projectManagerIsActive: boolean;
  createdBy: string;
  createdByName: string | null;
};

export type ProjectManagerOption = { id: string; fullName: string | null; email: string | null };

/** Editable fields after client/server validation. Dates are YYYY-MM-DD or null. */
export type ProjectFieldValues = {
  name: string;
  description: string | null;
  priority: ProjectPriority;
  startDate: string | null;
  targetDate: string | null;
};

export type CreateProjectValues = ProjectFieldValues & {
  projectKey: string;
  projectManagerId: string | null;
};

export type UpdateProjectValues = ProjectFieldValues & { status: ProjectStatus };

export type ProjectField = "name" | "projectKey" | "description" | "status" | "priority" | "startDate" | "targetDate" | "projectManagerId";
export type ProjectFieldErrors = Partial<Record<ProjectField, string>>;
