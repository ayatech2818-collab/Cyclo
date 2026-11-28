import Link from "next/link";
import { Search, SlidersHorizontal } from "lucide-react";

import { control, primaryButton, secondaryButton } from "@/components/ui/styles";
import { PRIORITY_LABELS, PROJECT_PRIORITIES } from "@/features/projects/types";
import { TYPE_LABELS, WORK_ITEM_STATUSES, WORK_STATUS_LABELS } from "@/features/work-items/types";
import { cn } from "@/lib/utils/cn";

import { CLEARED_FILTERS, DEFAULT_PAGE_SIZE, backlogHref, hasBacklogFilters, panelFilterCount } from "../logic";
import { BACKLOG_GROUPS, BACKLOG_TYPES, GROUP_LABELS, type BacklogEpic, type BacklogQuery } from "../types";

const label = "mb-1.5 block text-xs font-medium text-text-secondary";

/**
 * Compact GET form (Phase 8H Part 4): search and grouping stay visible; the
 * other filters sit in a disclosure that opens when any of them is set.
 * Everything lives in the URL and works without JavaScript.
 */
export function BacklogFilters({ projectId, query, assignees, epics, selfId }: {
  projectId: string;
  query: BacklogQuery;
  assignees: { id: string; name: string }[];
  epics: BacklogEpic[];
  selfId: string;
}) {
  const assigneeValue = query.assignee.kind === "unassigned" ? "none" : query.assignee.kind === "person" ? query.assignee.id : "";
  const epicValue = query.epic.kind === "none" ? "none" : query.epic.kind === "epic" ? query.epic.id : "";
  const isMember = assignees.some((person) => person.id === selfId);
  const active = panelFilterCount(query);

  return (
    <form method="get" action={`/projects/${projectId}/backlog`} role="search" aria-label="Filter backlog"
      className="rounded-xl border border-border bg-surface p-3 shadow-sm sm:p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-[1_1_16rem]">
          <label htmlFor="bl-search" className="sr-only">Search</label>
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted" />
            <input id="bl-search" name="q" type="search" defaultValue={query.search} maxLength={100} placeholder="Search by title or key" autoComplete="off" className={cn(control, "rounded-full pl-9")} />
          </div>
        </div>
        <div className="flex flex-[1_1_12rem] items-center gap-2">
          <label htmlFor="bl-group" className="shrink-0 text-xs font-medium text-text-secondary">Group by</label>
          <select id="bl-group" name="group" defaultValue={query.group} className={control}>
            {BACKLOG_GROUPS.map((group) => <option key={group} value={group}>{GROUP_LABELS[group]}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <button type="submit" className={cn(primaryButton, "px-5")}>Apply</button>
          {hasBacklogFilters(query) && <Link href={backlogHref(projectId, query, CLEARED_FILTERS)} className={secondaryButton}>Clear</Link>}
        </div>
      </div>

      <details open={active > 0} className="group mt-3 border-t border-border pt-3">
        <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-full px-1 text-sm font-medium text-text-secondary select-none hover:text-text-primary [&::-webkit-details-marker]:hidden">
          <SlidersHorizontal aria-hidden="true" className="size-4" />
          Filters
          {active > 0 && <span className="rounded-full bg-primary-soft px-1.5 text-xs font-semibold text-primary-strong tabular-nums">{active}</span>}
          <span className="hidden text-xs text-text-muted group-open:hidden sm:inline">· type, status, priority, assignee, epic</span>
        </summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.4fr)_auto] lg:items-end">
          <div>
            <label htmlFor="bl-type" className={label}>Type</label>
            <select id="bl-type" name="type" defaultValue={query.type ?? ""} className={control}>
              <option value="">Stories, tasks, bugs</option>
              {BACKLOG_TYPES.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="bl-status" className={label}>Status</label>
            <select id="bl-status" name="status" defaultValue={query.status ?? ""} className={control}>
              <option value="">Any status</option>
              {WORK_ITEM_STATUSES.filter((status) => query.includeCompleted || (status !== "DONE" && status !== "CANCELLED")).map((status) => (
                <option key={status} value={status}>{WORK_STATUS_LABELS[status]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="bl-priority" className={label}>Priority</label>
            <select id="bl-priority" name="priority" defaultValue={query.priority ?? ""} className={control}>
              <option value="">Any priority</option>
              {PROJECT_PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="bl-assignee" className={label}>Assignee</label>
            <select id="bl-assignee" name="assignee" defaultValue={assigneeValue} className={control}>
              <option value="">Anyone</option>
              <option value="none">Unassigned</option>
              {isMember && <option value={selfId}>Me</option>}
              {assignees.filter((person) => person.id !== selfId).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="bl-epic" className={label}>Epic</label>
            <select id="bl-epic" name="epic" defaultValue={epicValue} className={control}>
              <option value="">Any epic</option>
              <option value="none">No epic</option>
              {epics.map((epic) => <option key={epic.id} value={epic.id}>{epic.label}</option>)}
            </select>
          </div>
          <label className="flex h-9 items-center gap-2 text-sm whitespace-nowrap text-text-secondary">
            <input type="checkbox" name="completed" value="1" defaultChecked={query.includeCompleted} className="size-4 accent-[var(--primary)]" />
            Show done &amp; cancelled
          </label>
        </div>
      </details>
      {query.pageSize !== DEFAULT_PAGE_SIZE && <input type="hidden" name="size" value={query.pageSize} />}
    </form>
  );
}
