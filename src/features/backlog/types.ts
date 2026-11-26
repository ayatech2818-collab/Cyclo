import type { ProjectPriority } from "@/features/projects/types";
import type { AssigneeFilter, WorkItemStatus, WorkItemType } from "@/features/work-items/types";

/** Types that appear as backlog rows (epics group them; subtasks roll up into their task). */
export const BACKLOG_TYPES = ["STORY", "TASK", "BUG"] as const satisfies readonly WorkItemType[];
export type BacklogType = (typeof BACKLOG_TYPES)[number];

/** Types that can be quick-created from the backlog. */
export const QUICK_CREATE_TYPES = ["TASK", "BUG"] as const satisfies readonly WorkItemType[];
export type QuickCreateType = (typeof QUICK_CREATE_TYPES)[number];

/** Must match private.list_backlog's allow-list. */
export const BACKLOG_GROUPS = ["none", "epic", "type", "priority", "status"] as const;
export type BacklogGroup = (typeof BACKLOG_GROUPS)[number];

export const GROUP_LABELS: Record<BacklogGroup, string> = {
  none: "No grouping",
  epic: "Epic",
  type: "Type",
  priority: "Priority",
  status: "Status",
};

export type EpicFilter = { kind: "any" } | { kind: "none" } | { kind: "epic"; id: string };

export type BacklogQuery = {
  search: string;
  type: BacklogType | null;
  status: WorkItemStatus | null;
  priority: ProjectPriority | null;
  assignee: AssigneeFilter;
  epic: EpicFilter;
  includeCompleted: boolean;
  group: BacklogGroup;
  page: number;
  pageSize: number;
};

export type BacklogItem = {
  id: string;
  issueKey: string;
  type: BacklogType;
  title: string;
  status: WorkItemStatus;
  priority: ProjectPriority;
  assigneeId: string | null;
  assigneeName: string | null;
  estimate: number | null;
  epicId: string | null;
  epicKey: string | null;
  epicTitle: string | null;
  subtaskCount: number;
};

export type BacklogPage = { items: BacklogItem[]; total: number; page: number; pageSize: number; pageCount: number };

export type BacklogEpic = { id: string; label: string; count: number; estimate: number | null };

export type BacklogSummary = {
  total: number;
  estimate: number | null;
  byStatus: Partial<Record<WorkItemStatus, number>>;
  byType: Partial<Record<BacklogType, number>>;
  byPriority: Partial<Record<ProjectPriority, number>>;
  unassigned: number;
  unestimated: number;
  epics: BacklogEpic[];
  withoutEpic: number;
};

/** Where a dragged item lands: right after `afterId`, or (at the top) right before `beforeId`. */
export type Placement = { afterId: string | null; beforeId: string | null };
