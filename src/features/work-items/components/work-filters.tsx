import Link from "next/link";
import { Search } from "lucide-react";

import { control, primaryButton, secondaryButton } from "@/features/projects/components/styles";
import { PRIORITY_LABELS, PROJECT_PRIORITIES } from "@/features/projects/types";
import { cn } from "@/lib/utils/cn";

import { TYPE_LABELS, WORK_ITEM_SORTS, WORK_ITEM_STATUSES, WORK_ITEM_TYPES, WORK_SORT_LABELS, WORK_STATUS_LABELS, type WorkItemListQuery } from "../types";
import { DEFAULT_PAGE_SIZE, hasActiveWorkFilters, workItemsHref } from "../validation";

const segment = "inline-flex h-9 items-center rounded-md px-3 text-sm font-medium";

export type AssigneeChoice = { id: string; name: string };

/** GET form: shareable URLs, works without JavaScript, resets to page 1. */
export function WorkFilters({ projectId, query, assignees, selfId }: {
  projectId: string;
  query: WorkItemListQuery;
  assignees: AssigneeChoice[];
  selfId: string;
}) {
  const assigneeValue = query.assignee.kind === "unassigned" ? "none" : query.assignee.kind === "person" ? query.assignee.id : "";
  const others = assignees.filter((person) => person.id !== selfId);
  const isMember = assignees.some((person) => person.id === selfId);
  const label = "mb-1.5 block text-xs font-medium text-text-secondary";

  return (
    <div className="space-y-4">
      <nav aria-label="Work item scope" className="inline-flex rounded-lg bg-surface-muted p-1">
        {[{ archived: false, text: "Active" }, { archived: true, text: "Archived" }].map((scope) => (
          <Link
            key={scope.text}
            href={workItemsHref(projectId, query, { archived: scope.archived, page: 1 })}
            aria-current={query.archived === scope.archived ? "page" : undefined}
            className={cn(segment, query.archived === scope.archived ? "bg-surface text-text-primary shadow-sm" : "text-text-secondary hover:text-text-primary")}
          >
            {scope.text}
          </Link>
        ))}
      </nav>

      <form method="get" action={`/projects/${projectId}/work`} role="search" aria-label="Filter work items" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
        <div className="sm:col-span-2 lg:col-span-2">
          <label htmlFor="work-search" className={label}>Search</label>
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-secondary" />
            <input id="work-search" name="q" type="search" defaultValue={query.search} maxLength={100} placeholder="Title or key, e.g. CPR-12" autoComplete="off" className={cn(control, "pl-9")} />
          </div>
        </div>
        <div>
          <label htmlFor="work-type" className={label}>Type</label>
          <select id="work-type" name="type" defaultValue={query.type ?? ""} className={control}>
            <option value="">All types</option>
            {WORK_ITEM_TYPES.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="work-status" className={label}>Status</label>
          <select id="work-status" name="status" defaultValue={query.status ?? ""} className={control}>
            <option value="">All statuses</option>
            {WORK_ITEM_STATUSES.map((status) => <option key={status} value={status}>{WORK_STATUS_LABELS[status]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="work-priority" className={label}>Priority</label>
          <select id="work-priority" name="priority" defaultValue={query.priority ?? ""} className={control}>
            <option value="">All priorities</option>
            {PROJECT_PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="work-assignee" className={label}>Assignee</label>
          <select id="work-assignee" name="assignee" defaultValue={assigneeValue} className={control}>
            <option value="">Anyone</option>
            <option value="none">Unassigned</option>
            {isMember && <option value={selfId}>Me</option>}
            {others.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2 lg:col-span-2">
          <label htmlFor="work-sort" className={label}>Sort by</label>
          <select id="work-sort" name="sort" defaultValue={query.sort} className={control}>
            {WORK_ITEM_SORTS.map((sort) => <option key={sort} value={sort}>{WORK_SORT_LABELS[sort]}</option>)}
          </select>
        </div>

        {query.archived && <input type="hidden" name="archived" value="1" />}
        {query.pageSize !== DEFAULT_PAGE_SIZE && <input type="hidden" name="size" value={query.pageSize} />}

        <div className="flex gap-2 sm:col-span-2 lg:col-span-4 lg:justify-end">
          {hasActiveWorkFilters(query) && (
            <Link href={workItemsHref(projectId, { ...query, search: "", type: null, status: null, priority: null, assignee: { kind: "any" }, page: 1 })} className={secondaryButton}>
              Clear
            </Link>
          )}
          <button type="submit" className={cn(primaryButton, "flex-1 lg:flex-none")}>Apply</button>
        </div>
      </form>
    </div>
  );
}
