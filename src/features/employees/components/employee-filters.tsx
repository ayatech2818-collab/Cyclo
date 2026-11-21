import Link from "next/link";
import { Search } from "lucide-react";

import { APP_ROLES, ROLE_LABELS, type EmployeeDirectoryQuery } from "../types";
import { DEFAULT_PAGE_SIZE, SEARCH_MAX_LENGTH, hasActiveFilters } from "../validation";

const control =
  "h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-text-primary focus-visible:border-primary";

/**
 * Plain GET form: works without JavaScript, keeps state in the URL (shareable,
 * back-button friendly) and resets to page 1 on every search.
 */
export function EmployeeFilters({ query }: { query: EmployeeDirectoryQuery }) {
  return (
    <form method="get" action="/employees" role="search" aria-label="Filter employees" className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_9rem_auto] sm:items-end">
      <div>
        <label htmlFor="employee-search" className="mb-1.5 block text-xs font-medium text-text-secondary">Search</label>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-secondary" />
          <input
            id="employee-search"
            name="q"
            type="search"
            defaultValue={query.search}
            maxLength={SEARCH_MAX_LENGTH}
            placeholder="Name, email or employee code"
            autoComplete="off"
            className={`${control} pl-9`}
          />
        </div>
      </div>

      <div>
        <label htmlFor="employee-role" className="mb-1.5 block text-xs font-medium text-text-secondary">Role</label>
        <select id="employee-role" name="role" defaultValue={query.role ?? ""} className={control}>
          <option value="">All roles</option>
          {APP_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
        </select>
      </div>

      <div>
        <label htmlFor="employee-status" className="mb-1.5 block text-xs font-medium text-text-secondary">Status</label>
        <select id="employee-status" name="status" defaultValue={query.status === "all" ? "" : query.status} className={control}>
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {query.pageSize !== DEFAULT_PAGE_SIZE && <input type="hidden" name="size" value={query.pageSize} />}

      <div className="flex gap-2">
        <button type="submit" className="h-10 flex-1 rounded-md bg-primary px-4 text-sm font-medium text-surface hover:bg-primary-hover sm:flex-none">
          Apply
        </button>
        {hasActiveFilters(query) && (
          <Link href="/employees" className="inline-flex h-10 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium text-text-primary hover:bg-background">
            Clear
          </Link>
        )}
      </div>
    </form>
  );
}
