import Link from "next/link";
import { CornerDownRight } from "lucide-react";

import { ProjectPriorityBadge } from "@/features/projects/components/project-badges";
import { formatProjectDate } from "@/features/projects/format";

import type { WorkItemListItem } from "../types";
import { formatEstimate } from "../validation";
import { IssueKey, WorkStatusBadge, WorkTypeIcon } from "./work-badges";

/** Compact, scannable list. On phones the secondary columns fold under the title. */
export function WorkList({ projectId, items }: { projectId: string; items: WorkItemListItem[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <div className="hidden grid-cols-[minmax(0,1fr)_8rem_7rem_10rem_6rem] gap-4 border-b border-border bg-surface-muted/60 px-4 py-2.5 text-xs font-medium text-text-secondary md:grid">
        <span>Work item</span>
        <span>Status</span>
        <span>Priority</span>
        <span>Assignee</span>
        <span className="text-right">Due</span>
      </div>
      <ul className="divide-y divide-border">
        {items.map((item) => {
          const estimate = formatEstimate(item.estimate);
          return (
            <li key={item.id} className="relative grid gap-2 px-4 py-3 hover:bg-surface-muted/50 md:grid-cols-[minmax(0,1fr)_8rem_7rem_10rem_6rem] md:items-center md:gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <WorkTypeIcon type={item.type} className="mt-0.5" />
                <div className="min-w-0">
                  <Link href={`/projects/${projectId}/work/${item.id}`} className="block truncate text-sm font-medium after:absolute after:inset-0 hover:text-primary">
                    {item.title}
                  </Link>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted">
                    <IssueKey issueKey={item.issueKey} />
                    {item.parentIssueKey && (
                      <span className="inline-flex items-center gap-1"><CornerDownRight aria-hidden="true" className="size-3" />{item.parentIssueKey}</span>
                    )}
                    {item.childCount > 0 && <span>{item.childCount} child item{item.childCount === 1 ? "" : "s"}</span>}
                    {estimate && <span>Est. {estimate}</span>}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 pl-9 md:contents">
                <span><WorkStatusBadge status={item.status} /></span>
                <span><ProjectPriorityBadge priority={item.priority} /></span>
                <span className="truncate text-sm text-text-secondary">
                  <span className="md:hidden">· </span>{item.assigneeName ?? <span className="text-text-muted">Unassigned</span>}
                </span>
                <span className="text-xs whitespace-nowrap text-text-secondary md:text-right md:text-sm">
                  {item.dueDate ? <><span className="md:hidden">Due </span>{formatProjectDate(item.dueDate)}</> : <span className="hidden text-text-muted md:inline">—</span>}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
