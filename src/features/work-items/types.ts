import type { ProjectPriority } from "@/features/projects/types";

/** Mirrors public.work_item_type. */
export const WORK_ITEM_TYPES = ["EPIC", "STORY", "TASK", "SUBTASK", "BUG"] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

/** Mirrors public.work_item_status (workflow order). */
export const WORK_ITEM_STATUSES = ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "DONE", "CANCELLED"] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const TYPE_LABELS: Record<WorkItemType, string> = {
  EPIC: "Epic",
  STORY: "Story",
  TASK: "Task",
  SUBTASK: "Subtask",
  BUG: "Bug",
};

export const WORK_STATUS_LABELS: Record<WorkItemStatus, string> = {
  BACKLOG: "Backlog",
  TODO: "To do",
  IN_PROGRESS: "In progress",
  IN_REVIEW: "In review",
  BLOCKED: "Blocked",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

/** Allowed parent types per child type. Mirrors private.work_item_parent_allowed. */
export const PARENT_TYPES: Record<WorkItemType, { allowed: readonly WorkItemType[]; required: boolean }> = {
  EPIC: { allowed: [], required: false },
  STORY: { allowed: ["EPIC"], required: false },
  TASK: { allowed: ["STORY"], required: false },
  SUBTASK: { allowed: ["TASK"], required: true },
  BUG: { allowed: ["EPIC", "STORY", "TASK"], required: false },
};

/**
 * Default workflow. Mirrors private.work_item_transitions as of Phase 8F2
 * (review decisions are manager-only; a unit test keeps them equal). managerOnly moves need SA or the assigned PM. Leaving BLOCKED
 * for an active status is further limited to the status it was blocked from.
 */
export const WORK_ITEM_TRANSITIONS: readonly { from: WorkItemStatus; to: WorkItemStatus; managerOnly: boolean }[] = [
  { from: "BACKLOG", to: "TODO", managerOnly: false },
  { from: "BACKLOG", to: "CANCELLED", managerOnly: true },
  { from: "TODO", to: "BACKLOG", managerOnly: false },
  { from: "TODO", to: "IN_PROGRESS", managerOnly: false },
  { from: "TODO", to: "BLOCKED", managerOnly: false },
  { from: "TODO", to: "CANCELLED", managerOnly: true },
  { from: "IN_PROGRESS", to: "TODO", managerOnly: false },
  { from: "IN_PROGRESS", to: "IN_REVIEW", managerOnly: false },
  { from: "IN_PROGRESS", to: "BLOCKED", managerOnly: false },
  { from: "IN_PROGRESS", to: "CANCELLED", managerOnly: true },
  { from: "IN_REVIEW", to: "IN_PROGRESS", managerOnly: true },
  { from: "IN_REVIEW", to: "DONE", managerOnly: true },
  { from: "IN_REVIEW", to: "BLOCKED", managerOnly: false },
  { from: "IN_REVIEW", to: "CANCELLED", managerOnly: true },
  { from: "BLOCKED", to: "TODO", managerOnly: false },
  { from: "BLOCKED", to: "IN_PROGRESS", managerOnly: false },
  { from: "BLOCKED", to: "IN_REVIEW", managerOnly: false },
  { from: "BLOCKED", to: "CANCELLED", managerOnly: true },
  { from: "DONE", to: "IN_PROGRESS", managerOnly: true },
  { from: "CANCELLED", to: "BACKLOG", managerOnly: true },
];

/** Allow-listed sort keys; must match private.list_work_items. */
export const WORK_ITEM_SORTS = ["updated_desc", "created_desc", "key_asc", "key_desc", "priority_desc", "due_asc", "status_asc", "title_asc"] as const;
export type WorkItemSort = (typeof WORK_ITEM_SORTS)[number];

export const WORK_SORT_LABELS: Record<WorkItemSort, string> = {
  updated_desc: "Recently updated",
  created_desc: "Newest first",
  key_asc: "Key ascending",
  key_desc: "Key descending",
  priority_desc: "Priority",
  due_asc: "Due date",
  status_asc: "Status",
  title_asc: "Title A–Z",
};

/** Assignee filter: anyone, unassigned, or one developer's id. */
export type AssigneeFilter = { kind: "any" } | { kind: "unassigned" } | { kind: "person"; id: string };

export type WorkItemListQuery = {
  search: string;
  type: WorkItemType | null;
  status: WorkItemStatus | null;
  priority: ProjectPriority | null;
  assignee: AssigneeFilter;
  archived: boolean;
  sort: WorkItemSort;
  page: number;
  pageSize: number;
};

export type WorkItemListItem = {
  id: string;
  issueKey: string;
  type: WorkItemType;
  title: string;
  status: WorkItemStatus;
  priority: ProjectPriority;
  parentId: string | null;
  parentIssueKey: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  estimate: number | null;
  childCount: number;
  updatedAt: string;
  archivedAt: string | null;
};

export type WorkItemListPage = { items: WorkItemListItem[]; total: number; page: number; pageSize: number; pageCount: number };

export type WorkItemDetail = {
  id: string;
  projectId: string;
  issueKey: string;
  type: WorkItemType;
  title: string;
  description: string | null;
  status: WorkItemStatus;
  blockedFromStatus: WorkItemStatus | null;
  priority: ProjectPriority;
  parent: { id: string; issueKey: string; title: string; type: WorkItemType } | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  /** False when the assignee left the team or was deactivated after assignment. */
  assigneeIsEligible: boolean;
  reporterId: string;
  reporterName: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimate: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
};

export type WorkItemChild = {
  id: string;
  issueKey: string;
  type: WorkItemType;
  title: string;
  status: WorkItemStatus;
  priority: ProjectPriority;
  assigneeName: string | null;
  archivedAt: string | null;
};

export type ParentOption = { id: string; issueKey: string; type: WorkItemType; title: string };

export type WorkItemField = "type" | "title" | "description" | "parentId" | "status" | "priority" | "assigneeId" | "startDate" | "dueDate" | "estimate";
export type WorkItemFieldErrors = Partial<Record<WorkItemField, string>>;

export type WorkItemContentValues = {
  title: string;
  description: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimate: number | null;
};

export type CreateWorkItemValues = WorkItemContentValues & {
  type: WorkItemType;
  parentId: string | null;
  status: "BACKLOG" | "TODO";
  priority: ProjectPriority;
  assigneeId: string | null;
};

/** What the viewer may do with a work item. UI gates only; the database decides. */
export type WorkItemPermissions = {
  canManage: boolean;
  canEdit: boolean;
  canTransition: boolean;
  nextStatuses: WorkItemStatus[];
};
