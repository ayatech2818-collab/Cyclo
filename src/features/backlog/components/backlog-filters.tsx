import Link from "next/link";
import { Search } from "lucide-react";

import { control, primaryButton, secondaryButton } from "@/features/projects/components/styles";
import { PRIORITY_LABELS, PROJECT_PRIORITIES } from "@/features/projects/types";
import { TYPE_LABELS, WORK_ITEM_STATUSES, WORK_STATUS_LABELS } from "@/features/work-items/types";
import { cn } from "@/lib/utils/cn";

import { CLEARED_FILTERS, DEFAULT_PAGE_SIZE, backlogHref, hasBacklogFilters } from "../logic";
import { BACKLOG_GROUPS, BACKLOG_TYPES, GROUP_LABELS, type BacklogEpic, type BacklogQuery } from "../types";

const label = "mb-1.5 block text-xs font-medium text-text-secondary";

/** GET form: filters live in the URL (shareable, back-button friendly). */
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

  return (
    <form method="get" action={`/projects/${projectId}/backlog`} role="search" aria-label="Filter backlog" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
      <div className="sm:col-span-2">
        <label htmlFor="bl-search" className={label}>Search</label>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-secondary" />
          <input id="bl-search" name="q" type="search" defaultValue={query.search} maxLength={100} placeholder="Title or key" autoComplete="off" className={cn(control, "pl-9")} />
        </div>
      </div>
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
      <div className="sm:col-span-2">
        <label htmlFor="bl-epic" className={label}>Epic</label>
        <select id="bl-epic" name="epic" defaultValue={epicValue} className={control}>
          <option value="">Any epic</option>
          <option value="none">No epic</option>
          {epics.map((epic) => <option key={epic.id} value={epic.id}>{epic.label}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="bl-group" className={label}>Group by</label>
        <select id="bl-group" name="group" defaultValue={query.group} className={control}>
          {BACKLOG_GROUPS.map((group) => <option key={group} value={group}>{GROUP_LABELS[group]}</option>)}
        </select>
      </div>
      <label className="flex h-10 items-center gap-2 text-sm text-text-secondary">
        <input type="checkbox" name="completed" value="1" defaultChecked={query.includeCompleted} className="size-4 accent-[var(--primary)]" />
        Show done &amp; cancelled
      </label>
      {query.pageSize !== DEFAULT_PAGE_SIZE && <input type="hidden" name="size" value={query.pageSize} />}
      <div className="flex gap-2 sm:col-span-2 lg:justify-end">
        {hasBacklogFilters(query) && <Link href={backlogHref(projectId, query, CLEARED_FILTERS)} className={secondaryButton}>Clear</Link>}
        <button type="submit" className={cn(primaryButton, "flex-1 lg:flex-none")}>Apply</button>
      </div>
    </form>
  );
}
