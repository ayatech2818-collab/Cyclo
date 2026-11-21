import type { AppRole } from "@/features/auth/access";

import { APP_ROLES, DIRECTORY_ROLES, type EmployeeDirectoryQuery, type EmployeeStatusFilter } from "./types";

// Must stay within the bounds enforced by public.list_employees.
export const SEARCH_MAX_LENGTH = 100;
export const PAGE_MAX = 100_000;
export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
export const DEFAULT_PAGE_SIZE = 20;

type SearchParams = Record<string, string | string[] | undefined>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

/** UI gate only; the database enforces the same rule on every directory RPC. */
export function canViewDirectory(role: AppRole): boolean {
  return (DIRECTORY_ROLES as readonly AppRole[]).includes(role);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Normalizes search text: strips control characters, collapses whitespace, trims, bounds length. */
export function normalizeSearch(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEARCH_MAX_LENGTH);
}

/**
 * Parses untrusted URL search params into a bounded directory query.
 * Invalid values fall back to safe defaults instead of failing the page.
 */
export function parseDirectoryQuery(params: SearchParams): EmployeeDirectoryQuery {
  const roleParam = single(params.role);
  const statusParam = single(params.status);
  const pageParam = single(params.page);
  const sizeParam = Number(single(params.size));

  const status: EmployeeStatusFilter =
    statusParam === "active" || statusParam === "inactive" ? statusParam : "all";

  let page = 1;
  if (pageParam && /^\d{1,6}$/.test(pageParam)) {
    page = Math.min(Math.max(Number(pageParam), 1), PAGE_MAX);
  }

  return {
    search: normalizeSearch(single(params.q)),
    role: isAppRole(roleParam) ? roleParam : null,
    status,
    page,
    pageSize: (PAGE_SIZE_OPTIONS as readonly number[]).includes(sizeParam) ? sizeParam : DEFAULT_PAGE_SIZE,
  };
}

export function hasActiveFilters(query: EmployeeDirectoryQuery): boolean {
  return Boolean(query.search || query.role || query.status !== "all");
}

/** Directory URL for the given query with optional overrides (e.g. another page). */
export function directoryHref(query: EmployeeDirectoryQuery, overrides: Partial<EmployeeDirectoryQuery> = {}): string {
  const params = directoryQueryToParams({ ...query, ...overrides }).toString();
  return params ? `/employees?${params}` : "/employees";
}

/** Serializes a query back to URL params, omitting defaults. */
export function directoryQueryToParams(query: EmployeeDirectoryQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search) params.set("q", query.search);
  if (query.role) params.set("role", query.role);
  if (query.status !== "all") params.set("status", query.status);
  if (query.pageSize !== DEFAULT_PAGE_SIZE) params.set("size", String(query.pageSize));
  if (query.page > 1) params.set("page", String(query.page));
  return params;
}
