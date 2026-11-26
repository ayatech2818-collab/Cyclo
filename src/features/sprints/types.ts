import type { ProjectPriority } from "@/features/projects/types";
import type { WorkItemStatus, WorkItemType } from "@/features/work-items/types";

/** Mirrors public.sprint_status (lifecycle order). */
export const SPRINT_STATUSES = ["PLANNING", "ACTIVE", "COMPLETED", "CANCELLED"] as const;
export type SprintStatus = (typeof SPRINT_STATUSES)[number];

export const SPRINT_STATUS_LABELS: Record<SprintStatus, string> = {
  PLANNING: "Planning",
  ACTIVE: "Active",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/** Must match private.list_sprints. */
export type SprintScope = "open" | "closed" | "all";

export type Sprint = {
  id: string;
  name: string;
  goal: string | null;
  status: SprintStatus;
  startDate: string | null;
  endDate: string | null;
  capacity: number | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  itemCount: number;
  doneCount: number;
  estimateTotal: number;
  doneEstimate: number;
  unestimatedCount: number;
};

export type SprintDetail = Sprint & { projectId: string; createdByName: string | null };

export type SprintPage = { sprints: Sprint[]; total: number; page: number; pageSize: number; pageCount: number };

export type SprintItem = {
  id: string;
  issueKey: string;
  type: WorkItemType;
  title: string;
  status: WorkItemStatus;
  priority: ProjectPriority;
  assigneeId: string | null;
  assigneeName: string | null;
  estimate: number | null;
  archivedAt: string | null;
};

export type CapacityRow = { assigneeId: string | null; assigneeName: string | null; itemCount: number; estimate: number; unestimated: number };

export type SprintFieldValues = { name: string; goal: string | null; startDate: string | null; endDate: string | null };
export type SprintField = "name" | "goal" | "startDate" | "endDate" | "capacity";
export type SprintFieldErrors = Partial<Record<SprintField, string>>;

/** Planning indicator derived from estimates and the manager-set capacity. Never blocks planning. */
export type CapacityState =
  | { kind: "unset"; planned: number }
  | { kind: "within"; planned: number; capacity: number; ratio: number }
  | { kind: "over"; planned: number; capacity: number; ratio: number; overBy: number };
