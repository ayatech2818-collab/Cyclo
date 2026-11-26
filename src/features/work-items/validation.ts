import type { AppRole } from "@/features/auth/access";

// Relative imports keep this module loadable by the plain-Node unit tests.
import { isProjectPriority, isUuid, normalizeSearch, isIsoDate } from "../projects/validation";
import {
  PARENT_TYPES,
  WORK_ITEM_SORTS,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TRANSITIONS,
  WORK_ITEM_TYPES,
  type AssigneeFilter,
  type CreateWorkItemValues,
  type WorkItemContentValues,
  type WorkItemFieldErrors,
  type WorkItemListQuery,
  type WorkItemPermissions,
  type WorkItemSort,
  type WorkItemStatus,
  type WorkItemType,
} from "./types";

/*
 * Pure work item rules shared by forms, Server Actions and tests. Each rule is
 * enforced again in the database (constraints, guard trigger and RPCs).
 */

export const TITLE_MAX = 255;
export const DESCRIPTION_MAX = 20_000;
export const ESTIMATE_MAX = 1000;
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
export const DEFAULT_SORT: WorkItemSort = "updated_desc";
export const PAGE_MAX = 100_000;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isWorkItemType(value: unknown): value is WorkItemType {
  return typeof value === "string" && (WORK_ITEM_TYPES as readonly string[]).includes(value);
}

export function isWorkItemStatus(value: unknown): value is WorkItemStatus {
  return typeof value === "string" && (WORK_ITEM_STATUSES as readonly string[]).includes(value);
}

export function isWorkItemSort(value: unknown): value is WorkItemSort {
  return typeof value === "string" && (WORK_ITEM_SORTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Hierarchy and permissions
// ---------------------------------------------------------------------------

export function isParentAllowed(child: WorkItemType, parent: WorkItemType | null): boolean {
  const rule = PARENT_TYPES[child];
  return parent === null ? !rule.required : rule.allowed.includes(parent);
}

/** Types that can sit directly under the given parent (for "Add child"). */
export function childTypesOf(parent: WorkItemType): WorkItemType[] {
  return WORK_ITEM_TYPES.filter((child) => PARENT_TYPES[child].allowed.includes(parent));
}

/** Super Admins and the project's PM manage work items. */
export function isWorkManager(viewer: { id: string; role: AppRole }, project: { projectManagerId: string }): boolean {
  return viewer.role === "SUPER_ADMIN" || (viewer.role === "PROJECT_MANAGER" && project.projectManagerId === viewer.id);
}

/** Types the viewer may create: managers any; member developers tasks and bugs. */
export function creatableTypes(isManager: boolean, role: AppRole): WorkItemType[] {
  if (isManager) return [...WORK_ITEM_TYPES];
  return role === "DEVELOPER" ? ["TASK", "BUG"] : [];
}

/** Statuses reachable from the current one for this viewer. */
export function nextStatuses(current: WorkItemStatus, blockedFrom: WorkItemStatus | null, isManager: boolean): WorkItemStatus[] {
  return WORK_ITEM_TRANSITIONS.filter(
    (transition) =>
      transition.from === current &&
      (isManager || !transition.managerOnly) &&
      !(current === "BLOCKED" && transition.to !== "CANCELLED" && transition.to !== blockedFrom),
  ).map((transition) => transition.to);
}

export function workItemPermissions(
  viewer: { id: string; role: AppRole },
  project: { projectManagerId: string; archivedAt: string | null },
  item: { assigneeId: string | null; status: WorkItemStatus; blockedFromStatus: WorkItemStatus | null; archivedAt: string | null },
): WorkItemPermissions {
  const writable = !project.archivedAt && !item.archivedAt;
  const canManage = isWorkManager(viewer, project);
  const isAssignee = item.assigneeId !== null && item.assigneeId === viewer.id;
  const canEdit = writable && (canManage || isAssignee);
  return {
    canManage: canManage && !project.archivedAt,
    canEdit,
    canTransition: canEdit,
    nextStatuses: canEdit ? nextStatuses(item.status, item.blockedFromStatus, canManage) : [],
  };
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type FieldResult<T> = { ok: true; values: T } | { ok: false; errors: WorkItemFieldErrors };

export function parseEstimate(value: unknown): number | null | "invalid" {
  const raw = text(value);
  if (!raw) return null;
  if (!/^\d{1,4}(\.\d)?$/.test(raw)) return "invalid";
  const parsed = Number(raw);
  return parsed > ESTIMATE_MAX ? "invalid" : parsed;
}

function validateContent(input: Record<string, unknown>, errors: WorkItemFieldErrors): WorkItemContentValues {
  const title = text(input.title);
  if (!title) errors.title = "Title is required.";
  else if (title.length > TITLE_MAX || CONTROL_CHARS.test(title)) errors.title = `Use up to ${TITLE_MAX} characters without line breaks.`;

  const description = text(input.description);
  if (description.length > DESCRIPTION_MAX) errors.description = `Keep the description under ${DESCRIPTION_MAX.toLocaleString("en-US")} characters.`;

  const startDate = text(input.startDate);
  const dueDate = text(input.dueDate);
  if (startDate && !isIsoDate(startDate)) errors.startDate = "Enter a valid date.";
  if (dueDate && !isIsoDate(dueDate)) errors.dueDate = "Enter a valid date.";
  if (!errors.startDate && !errors.dueDate && startDate && dueDate && startDate > dueDate) {
    errors.dueDate = "Due date must be on or after the start date.";
  }

  const estimate = parseEstimate(input.estimate);
  if (estimate === "invalid") errors.estimate = `Use a number from 0 to ${ESTIMATE_MAX}, with at most one decimal.`;

  return {
    title,
    description: description || null,
    startDate: startDate || null,
    dueDate: dueDate || null,
    estimate: estimate === "invalid" ? null : estimate,
  };
}

export function validateWorkItemContent(input: Record<string, unknown>): FieldResult<WorkItemContentValues> {
  const errors: WorkItemFieldErrors = {};
  const values = validateContent(input, errors);
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

/**
 * Create form. `allowedTypes` comes from the viewer's role; a developer's
 * assignee may only be themselves (`selfId`) or nobody.
 */
export function validateCreateWorkItem(
  input: Record<string, unknown>,
  options: { allowedTypes: readonly WorkItemType[]; isManager: boolean; selfId: string },
): FieldResult<CreateWorkItemValues> {
  const errors: WorkItemFieldErrors = {};
  const content = validateContent(input, errors);

  const type = input.type;
  if (!isWorkItemType(type) || !options.allowedTypes.includes(type)) errors.type = "Choose a type.";

  const parentId = text(input.parentId);
  if (parentId && !isUuid(parentId)) errors.parentId = "Choose a valid parent.";
  if (isWorkItemType(type) && !parentId && PARENT_TYPES[type].required) errors.parentId = "A subtask needs a parent task.";
  if (isWorkItemType(type) && parentId && PARENT_TYPES[type].allowed.length === 0) errors.parentId = "Epics cannot have a parent.";

  const status = input.status;
  if (status !== "BACKLOG" && status !== "TODO") errors.status = "New items start in Backlog or To do.";

  const priority = input.priority;
  if (!isProjectPriority(priority)) errors.priority = "Choose a priority.";

  const assigneeId = text(input.assigneeId);
  if (assigneeId && !isUuid(assigneeId)) errors.assigneeId = "Choose a developer.";
  else if (assigneeId && !options.isManager && assigneeId.toLowerCase() !== options.selfId.toLowerCase()) {
    errors.assigneeId = "You can assign new work only to yourself.";
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    values: {
      ...content,
      type: type as WorkItemType,
      parentId: parentId ? parentId.toLowerCase() : null,
      status: status as "BACKLOG" | "TODO",
      priority: priority as CreateWorkItemValues["priority"],
      assigneeId: assigneeId ? assigneeId.toLowerCase() : null,
    },
  };
}

// ---------------------------------------------------------------------------
// List query (URL state)
// ---------------------------------------------------------------------------

function parseAssignee(value: string | undefined): AssigneeFilter {
  if (value === "none") return { kind: "unassigned" };
  if (value && isUuid(value)) return { kind: "person", id: value.toLowerCase() };
  return { kind: "any" };
}

export function parseWorkItemListQuery(params: SearchParams): WorkItemListQuery {
  const type = single(params.type);
  const status = single(params.status);
  const priority = single(params.priority);
  const sort = single(params.sort);
  const pageParam = single(params.page);
  const size = Number(single(params.size));
  let page = 1;
  if (pageParam && /^\d{1,6}$/.test(pageParam)) page = Math.min(Math.max(Number(pageParam), 1), PAGE_MAX);
  return {
    search: normalizeSearch(single(params.q)),
    type: isWorkItemType(type) ? type : null,
    status: isWorkItemStatus(status) ? status : null,
    priority: isProjectPriority(priority) ? priority : null,
    assignee: parseAssignee(single(params.assignee)),
    archived: single(params.archived) === "1",
    sort: isWorkItemSort(sort) ? sort : DEFAULT_SORT,
    page,
    pageSize: (PAGE_SIZE_OPTIONS as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  };
}

export function hasActiveWorkFilters(query: WorkItemListQuery): boolean {
  return Boolean(query.search || query.type || query.status || query.priority || query.assignee.kind !== "any");
}

export function workItemQueryToParams(query: WorkItemListQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search) params.set("q", query.search);
  if (query.type) params.set("type", query.type);
  if (query.status) params.set("status", query.status);
  if (query.priority) params.set("priority", query.priority);
  if (query.assignee.kind === "unassigned") params.set("assignee", "none");
  if (query.assignee.kind === "person") params.set("assignee", query.assignee.id);
  if (query.archived) params.set("archived", "1");
  if (query.sort !== DEFAULT_SORT) params.set("sort", query.sort);
  if (query.pageSize !== DEFAULT_PAGE_SIZE) params.set("size", String(query.pageSize));
  if (query.page > 1) params.set("page", String(query.page));
  return params;
}

export function workItemsHref(projectId: string, query: WorkItemListQuery, overrides: Partial<WorkItemListQuery> = {}): string {
  const params = workItemQueryToParams({ ...query, ...overrides }).toString();
  return `/projects/${projectId}/work${params ? `?${params}` : ""}`;
}

export function formatEstimate(estimate: number | null): string | null {
  return estimate === null ? null : Number.isInteger(estimate) ? String(estimate) : estimate.toFixed(1);
}
