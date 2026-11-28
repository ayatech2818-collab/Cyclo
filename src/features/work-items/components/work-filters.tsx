import Link from "next/link";
import { Search, UserRound, UserX } from "lucide-react";

import { control, primaryButton, secondaryButton } from "@/components/ui/styles";
import { PRIORITY_LABELS, PROJECT_PRIORITIES } from "@/features/projects/types";
import { cn } from "@/lib/utils/cn";

import { TYPE_LABELS, WORK_ITEM_SORTS, WORK_ITEM_STATUSES, WORK_ITEM_TYPES, WORK_SORT_LABELS, WORK_STATUS_LABELS, type WorkItemListQuery } from "../types";
import { DEFAULT_PAGE_SIZE, hasActiveWorkFilters, workItemsHref } from "../validation";
import { WorkTypeIcon } from "./work-badges";

const segment = "inline-flex h-8 items-center rounded-full px-3 text-sm font-medium transition-colors duration-100";
const chip = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors duration-100";
const chipActive = "border-primary/40 bg-primary-soft text-primary-strong";
const chipIdle = "border-border bg-surface text-text-secondary hover:border-border-strong hover:text-text-primary";
const fieldLabel = "mb-1.5 block text-xs font-medium text-text-secondary";

export type AssigneeChoice = { id: string; name: string };

const CLEARED = { search: "", type: null, status: null, priority: null, assignee: { kind: "any" }, page: 1 } as const;

/**
 * Work item filters (Phase 8H Part 3): scope, type chips and quick assignee
 * chips are links; the rest is a GET form. Everything lives in the URL.
 */
export function WorkFilters({ projectId, query, assignees, selfId }: {
  projectId: string;
  query: WorkItemListQuery;
  assignees: AssigneeChoice[];
  selfId: string;
}) {
  const assigneeValue = query.assignee.kind === "unassigned" ? "none" : query.assignee.kind === "person" ? query.assignee.id : "";
  const others = assignees.filter((person) => person.id !== selfId);
  const isMember = assignees.some((person) => person.id === selfId);
  const mine = query.assignee.kind === "person" && query.assignee.id === selfId;
  const unassigned = query.assignee.kind === "unassigned";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Work item scope" className="inline-flex rounded-full bg-surface-muted p-1">
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
        <nav aria-label="Quick filters" className="flex flex-wrap gap-2">
          {isMember && (
            <Link href={workItemsHref(projectId, query, { assignee: mine ? { kind: "any" } : { kind: "person", id: selfId }, page: 1 })}
              aria-current={mine ? "true" : undefined} className={cn(chip, mine ? chipActive : chipIdle)}>
              <UserRound aria-hidden="true" className="size-3.5" />Assigned to me
            </Link>
          )}
          <Link href={workItemsHref(projectId, query, { assignee: unassigned ? { kind: "any" } : { kind: "unassigned" }, page: 1 })}
            aria-current={unassigned ? "true" : undefined} className={cn(chip, unassigned ? chipActive : chipIdle)}>
            <UserX aria-hidden="true" className="size-3.5" />Unassigned
          </Link>
        </nav>
      </div>

      <nav aria-label="Filter by type" className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-2">
          <li>
            <Link href={workItemsHref(projectId, query, { type: null, page: 1 })} aria-current={query.type === null ? "true" : undefined}
              className={cn(chip, "px-3", query.type === null ? chipActive : chipIdle)}>
              All types
            </Link>
          </li>
          {WORK_ITEM_TYPES.map((type) => (
            <li key={type}>
              <Link href={workItemsHref(projectId, query, { type, page: 1 })} aria-current={query.type === type ? "true" : undefined}
                className={cn(chip, "pl-1", query.type === type ? chipActive : chipIdle)}>
                <WorkTypeIcon type={type} className="size-6 rounded-full" />
                {TYPE_LABELS[type]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <form method="get" action={`/projects/${projectId}/work`} role="search" aria-label="Filter work items"
        className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))_minmax(0,1.25fr)_auto] lg:items-end">
        <div className="sm:col-span-2 lg:col-span-1">
          <label htmlFor="work-search" className={fieldLabel}>Search</label>
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted" />
            <input id="work-search" name="q" type="search" defaultValue={query.search} maxLength={100} placeholder="Title or key, e.g. CPR-12" autoComplete="off" className={cn(control, "rounded-full pl-9")} />
          </div>
        </div>
        <div>
          <label htmlFor="work-status" className={fieldLabel}>Status</label>
          <select id="work-status" name="status" defaultValue={query.status ?? ""} className={control}>
            <option value="">All statuses</option>
            {WORK_ITEM_STATUSES.map((status) => <option key={status} value={status}>{WORK_STATUS_LABELS[status]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="work-priority" className={fieldLabel}>Priority</label>
          <select id="work-priority" name="priority" defaultValue={query.priority ?? ""} className={control}>
            <option value="">All priorities</option>
            {PROJECT_PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="work-assignee" className={fieldLabel}>Assignee</label>
          <select id="work-assignee" name="assignee" defaultValue={assigneeValue} className={control}>
            <option value="">Anyone</option>
            <option value="none">Unassigned</option>
            {isMember && <option value={selfId}>Me</option>}
            {others.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="work-sort" className={fieldLabel}>Sort by</label>
          <select id="work-sort" name="sort" defaultValue={query.sort} className={control}>
            {WORK_ITEM_SORTS.map((sort) => <option key={sort} value={sort}>{WORK_SORT_LABELS[sort]}</option>)}
          </select>
        </div>

        {query.type && <input type="hidden" name="type" value={query.type} />}
        {query.archived && <input type="hidden" name="archived" value="1" />}
        {query.pageSize !== DEFAULT_PAGE_SIZE && <input type="hidden" name="size" value={query.pageSize} />}

        <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
          <button type="submit" className={cn(primaryButton, "flex-1 lg:flex-none")}>Apply</button>
          {hasActiveWorkFilters(query) && (
            <Link href={workItemsHref(projectId, { ...query, ...CLEARED })} className={secondaryButton}>Clear</Link>
          )}
        </div>
      </form>
    </div>
  );
}
