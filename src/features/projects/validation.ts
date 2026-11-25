import type { AppRole } from "@/features/auth/access";

import {
  PROJECT_CREATOR_ROLES,
  PROJECT_PRIORITIES,
  PROJECT_SORTS,
  PROJECT_STATUSES,
  type CreateProjectValues,
  type ProjectFieldErrors,
  type ProjectFieldValues,
  type ProjectListQuery,
  type ProjectPriority,
  type ProjectSort,
  type ProjectStatus,
  type UpdateProjectValues,
} from "./types";

/*
 * Pure, framework-free project validation shared by forms, Server Actions and
 * tests. Every rule is enforced again by the database (constraints + RPCs);
 * these checks exist for fast, field-level feedback.
 */

// Must stay within the bounds enforced by private.list_projects.
export const SEARCH_MAX_LENGTH = 100;
export const PAGE_MAX = 100_000;
export const PAGE_SIZE_OPTIONS = [12, 24, 48] as const;
export const DEFAULT_PAGE_SIZE = 12;
export const DEFAULT_SORT: ProjectSort = "updated_desc";

export const NAME_MIN = 2;
export const NAME_MAX = 120;
export const DESCRIPTION_MAX = 5000;
export const KEY_MIN = 2;
export const KEY_MAX = 10;
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value);
}

export function isProjectPriority(value: unknown): value is ProjectPriority {
  return typeof value === "string" && (PROJECT_PRIORITIES as readonly string[]).includes(value);
}

export function isProjectSort(value: unknown): value is ProjectSort {
  return typeof value === "string" && (PROJECT_SORTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Permissions (UI gates only; the database decides)
// ---------------------------------------------------------------------------

export function canCreateProjects(role: AppRole): boolean {
  return (PROJECT_CREATOR_ROLES as readonly AppRole[]).includes(role);
}

/** Edit, archive and restore: Super Admins, or the assigned Project Manager. */
export function canManageProject(viewer: { id: string; role: AppRole }, project: { projectManagerId: string }): boolean {
  return viewer.role === "SUPER_ADMIN" || (viewer.role === "PROJECT_MANAGER" && project.projectManagerId === viewer.id);
}

/** Only Super Admins assign or reassign Project Managers. */
export function canAssignProjectManager(role: AppRole): boolean {
  return role === "SUPER_ADMIN";
}

// ---------------------------------------------------------------------------
// Project keys
// ---------------------------------------------------------------------------

export function normalizeProjectKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * Suggests a key from a project name: initials of up to four words for
 * multi-word names ("Customer Portal Revamp" -> "CPR"), otherwise the first
 * four letters ("Cyclone" -> "CYCL"). Always matches PROJECT_KEY_PATTERN or
 * returns "" when the name has no usable letters. Uniqueness is checked on save.
 */
export function suggestProjectKey(name: unknown): string {
  if (typeof name !== "string") return "";
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  // Keys must start with a letter: drop leading numeric-only words.
  while (words.length && !/^[A-Z]/.test(words[0])) words.shift();
  if (words.length === 0) return "";

  let key = words.length > 1 ? words.slice(0, 4).map((word) => word[0]).join("") : words[0].slice(0, 4);
  if (key.length < KEY_MIN) key = (words[0] + words.slice(1).join("")).slice(0, 3);
  if (key.length < KEY_MIN) key = `${key}P`.slice(0, KEY_MIN);
  key = key.slice(0, KEY_MAX);
  return PROJECT_KEY_PATTERN.test(key) ? key : "";
}

// ---------------------------------------------------------------------------
// Form validation
// ---------------------------------------------------------------------------

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** True for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900 || year > 2999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

type FieldResult<T> = { ok: true; values: T } | { ok: false; errors: ProjectFieldErrors };

function validateCommon(input: Record<string, unknown>, errors: ProjectFieldErrors): ProjectFieldValues {
  const name = text(input.name);
  if (name.length < NAME_MIN || name.length > NAME_MAX || CONTROL_CHARS.test(name)) {
    errors.name = name ? `Use ${NAME_MIN}–${NAME_MAX} characters without line breaks.` : "Project name is required.";
  }

  const description = text(input.description);
  if (description.length > DESCRIPTION_MAX) errors.description = `Keep the description under ${DESCRIPTION_MAX.toLocaleString("en-US")} characters.`;

  const priority = input.priority;
  if (!isProjectPriority(priority)) errors.priority = "Choose a priority.";

  const startDate = text(input.startDate);
  const targetDate = text(input.targetDate);
  if (startDate && !isIsoDate(startDate)) errors.startDate = "Enter a valid date.";
  if (targetDate && !isIsoDate(targetDate)) errors.targetDate = "Enter a valid date.";
  if (!errors.startDate && !errors.targetDate && startDate && targetDate && startDate > targetDate) {
    errors.targetDate = "Target date must be on or after the start date.";
  }

  return {
    name,
    description: description || null,
    priority: (isProjectPriority(priority) ? priority : "medium"),
    startDate: startDate || null,
    targetDate: targetDate || null,
  };
}

/**
 * Validates the create form. `requireManager` is true for Super Admins, who
 * must pick a PM; for Project Managers any submitted PM id is ignored (the
 * database assigns the caller).
 */
export function validateCreateProject(input: Record<string, unknown>, options: { requireManager: boolean }): FieldResult<CreateProjectValues> {
  const errors: ProjectFieldErrors = {};
  const common = validateCommon(input, errors);

  const projectKey = normalizeProjectKey(input.projectKey);
  if (!projectKey) errors.projectKey = "Project key is required.";
  else if (!PROJECT_KEY_PATTERN.test(projectKey)) {
    errors.projectKey = `Use ${KEY_MIN}–${KEY_MAX} letters or digits, starting with a letter.`;
  }

  let projectManagerId: string | null = null;
  if (options.requireManager) {
    const candidate = text(input.projectManagerId);
    if (!isUuid(candidate)) errors.projectManagerId = "Choose a Project Manager.";
    else projectManagerId = candidate.toLowerCase();
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, values: { ...common, projectKey, projectManagerId } };
}

export function validateUpdateProject(input: Record<string, unknown>): FieldResult<UpdateProjectValues> {
  const errors: ProjectFieldErrors = {};
  const common = validateCommon(input, errors);
  const status = input.status;
  if (!isProjectStatus(status)) errors.status = "Choose a status.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, values: { ...common, status: status as ProjectStatus } };
}

// ---------------------------------------------------------------------------
// Listing query (URL state)
// ---------------------------------------------------------------------------

export function normalizeSearch(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_LENGTH);
}

/** Parses untrusted URL params into a bounded query; invalid values fall back to defaults. */
export function parseProjectListQuery(params: SearchParams): ProjectListQuery {
  const status = single(params.status);
  const priority = single(params.priority);
  const sort = single(params.sort);
  const pageParam = single(params.page);
  const size = Number(single(params.size));

  let page = 1;
  if (pageParam && /^\d{1,6}$/.test(pageParam)) page = Math.min(Math.max(Number(pageParam), 1), PAGE_MAX);

  return {
    search: normalizeSearch(single(params.q)),
    status: isProjectStatus(status) ? status : null,
    priority: isProjectPriority(priority) ? priority : null,
    archived: single(params.archived) === "1",
    sort: isProjectSort(sort) ? sort : DEFAULT_SORT,
    view: single(params.view) === "list" ? "list" : "grid",
    page,
    pageSize: (PAGE_SIZE_OPTIONS as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  };
}

export function hasActiveFilters(query: ProjectListQuery): boolean {
  return Boolean(query.search || query.status || query.priority);
}

/** Serializes a query to URL params, omitting defaults. */
export function projectQueryToParams(query: ProjectListQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search) params.set("q", query.search);
  if (query.status) params.set("status", query.status);
  if (query.priority) params.set("priority", query.priority);
  if (query.archived) params.set("archived", "1");
  if (query.sort !== DEFAULT_SORT) params.set("sort", query.sort);
  if (query.view !== "grid") params.set("view", query.view);
  if (query.pageSize !== DEFAULT_PAGE_SIZE) params.set("size", String(query.pageSize));
  if (query.page > 1) params.set("page", String(query.page));
  return params;
}

export function projectsHref(query: ProjectListQuery, overrides: Partial<ProjectListQuery> = {}): string {
  const params = projectQueryToParams({ ...query, ...overrides }).toString();
  return params ? `/projects?${params}` : "/projects";
}
