import Link from "next/link";
import { CornerLeftUp, ListTree } from "lucide-react";

import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { ProjectPriorityBadge } from "@/features/projects/components/project-badges";
import { formatProjectDate } from "@/features/projects/format";
import { cn } from "@/lib/utils/cn";

import { DUE_TEXT, dueState } from "../presentation";
import type { WorkItemListItem } from "../types";
import { formatEstimate } from "../validation";
import { IssueKey, WorkStatusBadge, WorkTypeIcon } from "./work-badges";

const COLUMNS = "md:grid-cols-[minmax(0,1fr)_8.5rem_6.5rem] lg:grid-cols-[minmax(0,1fr)_8.5rem_6.5rem_10rem_4.5rem_7rem]";

/** Estimate as a small pill; nothing when not estimated. */
export function EstimatePill({ estimate, className }: { estimate: number | null; className?: string }) {
  const text = formatEstimate(estimate);
  if (!text) return null;
  return (
    <span className={cn("inline-flex h-5 items-center rounded-full bg-surface-muted px-2 text-[11px] font-semibold text-text-secondary tabular-nums", className)}>
      <span className="sr-only">Estimate: </span>{text}
    </span>
  );
}

/**
 * Scannable work list (Phase 8H Part 3). Hierarchy shows as the parent key
 * (links up) and a child count; on phones the secondary fields fold under the title.
 */
export function WorkList({ projectId, items, today }: { projectId: string; items: WorkItemListItem[]; today: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <div className={cn("hidden gap-4 border-b border-border bg-surface-muted/60 px-4 py-2.5 text-xs font-medium text-text-secondary md:grid", COLUMNS)}>
        <span>Work item</span>
        <span>Status</span>
        <span>Priority</span>
        <span className="hidden lg:block">Assignee</span>
        <span className="hidden text-right lg:block">Estimate</span>
        <span className="hidden text-right lg:block">Due</span>
      </div>
      <ul className="divide-y divide-border">
        {items.map((item) => {
          const due = dueState(item.dueDate, item.status, today);
          return (
            <li key={item.id} className={cn("group relative grid gap-2.5 px-4 py-3.5 transition-colors hover:bg-surface-muted/50 md:items-center md:gap-4", COLUMNS, item.archivedAt && "opacity-70")}>
              <div className="flex min-w-0 items-start gap-3">
                <WorkTypeIcon type={item.type} size="md" />
                <div className="min-w-0">
                  <Link href={`/projects/${projectId}/work/${item.id}`} className="line-clamp-2 text-sm font-medium after:absolute after:inset-0 group-hover:text-primary-strong md:line-clamp-1">
                    {item.title}
                  </Link>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-text-muted">
                    <IssueKey issueKey={item.issueKey} />
                    {item.parentIssueKey && item.parentId && (
                      // Above the row link so the parent is reachable on its own.
                      <Link href={`/projects/${projectId}/work/${item.parentId}`} className="relative z-10 inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px hover:border-border-strong hover:text-text-primary">
                        <CornerLeftUp aria-hidden="true" className="size-3" />
                        <span className="sr-only">Parent </span>
                        <span className="font-mono">{item.parentIssueKey}</span>
                      </Link>
                    )}
                    {item.childCount > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <ListTree aria-hidden="true" className="size-3.5" />
                        {item.childCount} child item{item.childCount === 1 ? "" : "s"}
                      </span>
                    )}
                    <EstimatePill estimate={item.estimate} className="lg:hidden" />
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pl-11 md:contents">
                <span><WorkStatusBadge status={item.status} /></span>
                <span><ProjectPriorityBadge priority={item.priority} /></span>
                <span className="flex min-w-0 items-center gap-2 text-sm text-text-secondary md:hidden lg:flex">
                  {item.assigneeName ? (
                    <>
                      <EmployeeAvatar fullName={item.assigneeName} email={null} avatarUrl={null} size="sm" />
                      <span className="truncate">{item.assigneeName}</span>
                    </>
                  ) : (
                    <span className="text-text-muted">Unassigned</span>
                  )}
                </span>
                <span className="hidden text-right lg:block"><EstimatePill estimate={item.estimate} /></span>
                <span className="text-xs whitespace-nowrap md:hidden lg:block lg:text-right">
                  {item.dueDate ? (
                    <>
                      <span className="block text-text-secondary lg:text-sm"><span className="lg:hidden">Due </span>{formatProjectDate(item.dueDate)}</span>
                      {due && due.tone !== "neutral" && <span className={cn("block font-medium", DUE_TEXT[due.tone])}>{due.label}</span>}
                    </>
                  ) : (
                    <span className="hidden text-text-muted lg:inline">—</span>
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
