import Link from "next/link";
import { LayoutGrid, List, Search } from "lucide-react";

import { cn } from "@/lib/utils/cn";

import { PRIORITY_LABELS, PROJECT_PRIORITIES, PROJECT_SORTS, PROJECT_STATUSES, SORT_LABELS, STATUS_LABELS, type ProjectListQuery } from "../types";
import { DEFAULT_PAGE_SIZE, SEARCH_MAX_LENGTH, hasActiveFilters, projectsHref } from "../validation";
import { control, primaryButton, secondaryButton } from "./styles";

const segment = "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors duration-100";
const segmentActive = "bg-surface text-text-primary shadow-sm";
const segmentIdle = "text-text-secondary hover:text-text-primary";

const chip = "inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-100";
const chipActive = "border-primary/40 bg-primary-soft text-primary-strong";
const chipIdle = "border-border bg-surface text-text-secondary hover:border-border-strong hover:text-text-primary";

const STATUS_DOTS: Record<(typeof PROJECT_STATUSES)[number], string> = {
  planning: "bg-text-muted",
  active: "bg-success",
  on_hold: "bg-warning",
  completed: "bg-primary",
  cancelled: "bg-danger",
};

/** Active/Archived scope and Grid/List view. Plain links keep state in the URL. */
export function ProjectScopeBar({ query }: { query: ProjectListQuery }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <nav aria-label="Project scope" className="inline-flex rounded-full bg-surface-muted p-1">
        <Link href={projectsHref(query, { archived: false, page: 1 })} aria-current={!query.archived ? "page" : undefined} className={cn(segment, !query.archived ? segmentActive : segmentIdle)}>
          Active
        </Link>
        <Link href={projectsHref(query, { archived: true, page: 1 })} aria-current={query.archived ? "page" : undefined} className={cn(segment, query.archived ? segmentActive : segmentIdle)}>
          Archived
        </Link>
      </nav>
      <div role="group" aria-label="Layout" className="inline-flex rounded-full bg-surface-muted p-1">
        <Link href={projectsHref(query, { view: "grid" })} aria-label="Grid view" aria-current={query.view === "grid" ? "true" : undefined} className={cn(segment, "px-2.5", query.view === "grid" ? segmentActive : segmentIdle)}>
          <LayoutGrid aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">Grid</span>
        </Link>
        <Link href={projectsHref(query, { view: "list" })} aria-label="List view" aria-current={query.view === "list" ? "true" : undefined} className={cn(segment, "px-2.5", query.view === "list" ? segmentActive : segmentIdle)}>
          <List aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">List</span>
        </Link>
      </div>
    </div>
  );
}

/** Quick status filter: each chip is a real link to the filtered list. */
export function ProjectStatusChips({ query }: { query: ProjectListQuery }) {
  return (
    <nav aria-label="Filter by status" className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-2">
        <li>
          <Link href={projectsHref(query, { status: null, page: 1 })} aria-current={query.status === null ? "true" : undefined} className={cn(chip, query.status === null ? chipActive : chipIdle)}>
            All statuses
          </Link>
        </li>
        {PROJECT_STATUSES.map((status) => (
          <li key={status}>
            <Link href={projectsHref(query, { status, page: 1 })} aria-current={query.status === status ? "true" : undefined} className={cn(chip, "gap-1.5", query.status === status ? chipActive : chipIdle)}>
              <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOTS[status])} />
              {STATUS_LABELS[status]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** GET form: works without JavaScript and resets to page 1 on every search. */
export function ProjectFilters({ query }: { query: ProjectListQuery }) {
  const clearHref = projectsHref({ ...query, search: "", status: null, priority: null, page: 1 });
  return (
    <form method="get" action="/projects" role="search" aria-label="Filter projects" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_10rem_11rem_auto] lg:items-end">
      <div className="sm:col-span-2 lg:col-span-1">
        <label htmlFor="project-search" className="mb-1.5 block text-xs font-medium text-text-secondary">Search</label>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted" />
          <input id="project-search" name="q" type="search" defaultValue={query.search} maxLength={SEARCH_MAX_LENGTH} placeholder="Search by project name or key" autoComplete="off" className={`${control} rounded-full pl-9`} />
        </div>
      </div>
      <div>
        <label htmlFor="project-priority" className="mb-1.5 block text-xs font-medium text-text-secondary">Priority</label>
        <select id="project-priority" name="priority" defaultValue={query.priority ?? ""} className={control}>
          <option value="">All priorities</option>
          {PROJECT_PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="project-sort" className="mb-1.5 block text-xs font-medium text-text-secondary">Sort by</label>
        <select id="project-sort" name="sort" defaultValue={query.sort} className={control}>
          {PROJECT_SORTS.map((sort) => <option key={sort} value={sort}>{SORT_LABELS[sort]}</option>)}
        </select>
      </div>

      {query.status && <input type="hidden" name="status" value={query.status} />}
      {query.archived && <input type="hidden" name="archived" value="1" />}
      {query.view !== "grid" && <input type="hidden" name="view" value={query.view} />}
      {query.pageSize !== DEFAULT_PAGE_SIZE && <input type="hidden" name="size" value={query.pageSize} />}

      <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
        <button type="submit" className={cn(primaryButton, "flex-1 lg:flex-none")}>Apply</button>
        {hasActiveFilters(query) && <Link href={clearHref} className={secondaryButton}>Clear all</Link>}
      </div>
    </form>
  );
}
