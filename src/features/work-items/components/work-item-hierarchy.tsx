import Link from "next/link";
import { CornerLeftUp, ListTree, Plus } from "lucide-react";

import { panel, secondaryButton } from "@/components/ui/styles";
import { cn } from "@/lib/utils/cn";

import type { ChildProgress } from "../presentation";
import { TYPE_LABELS, WORK_ITEM_STATUSES, WORK_STATUS_LABELS, type WorkItemChild, type WorkItemDetail, type WorkItemType } from "../types";
import { IssueKey, WORK_STATUS_STYLES, WorkStatusBadge, WorkTypeIcon } from "./work-badges";

/**
 * Parent and children of a work item (Phase 8H Part 3), with child progress
 * by status. "Add" links go to the existing create page with the parent set.
 */
export function WorkItemHierarchy({ projectId, item, items, progress, addTypes }: {
  projectId: string;
  item: WorkItemDetail;
  items: WorkItemChild[];
  progress: ChildProgress;
  /** Child types the viewer may create here; empty when read-only. */
  addTypes: WorkItemType[];
}) {
  if (!item.parent && items.length === 0 && addTypes.length === 0) return null;
  const showChildren = items.length > 0 || addTypes.length > 0;

  return (
    <section className={cn(panel, "overflow-hidden")} aria-labelledby="wi-children">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5 sm:px-6">
        <h2 id="wi-children" className="flex items-center gap-2 text-base font-semibold">
          <ListTree aria-hidden="true" className="size-4 text-text-secondary" />Hierarchy
        </h2>
        {addTypes.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {addTypes.map((type) => (
              <Link key={type} href={`/projects/${projectId}/work/new?type=${type}&parent=${item.id}`} className={cn(secondaryButton, "h-8 px-2.5 text-xs")}>
                <Plus aria-hidden="true" className="size-3.5" />{TYPE_LABELS[type]}
              </Link>
            ))}
          </div>
        )}
      </div>

      {item.parent && (
        <div className={cn("px-5 py-3 sm:px-6", showChildren && "border-b border-border")}>
          <p className="mb-1.5 text-xs font-medium text-text-muted">Parent</p>
          <Link href={`/projects/${projectId}/work/${item.parent.id}`} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-muted/60">
            <WorkTypeIcon type={item.parent.type} />
            <IssueKey issueKey={item.parent.issueKey} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.parent.title}</span>
            <CornerLeftUp aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
          </Link>
        </div>
      )}

      {showChildren && (
        <>
          <div className="px-5 pt-3 sm:px-6">
            <div className="flex items-center justify-between gap-3 text-xs">
              <p className="font-medium text-text-muted">
                Child items <span className="ml-1 rounded-full bg-surface-muted px-1.5 py-0.5 tabular-nums">{items.length}</span>
              </p>
              {progress.total > 0 && <p className="font-medium text-text-secondary tabular-nums">{progress.done} of {progress.total} done · {progress.percent}%</p>}
            </div>
            {progress.total > 0 && (
              <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-surface-muted" role="img"
                aria-label={WORK_ITEM_STATUSES.filter((status) => progress.byStatus[status]).map((status) => `${WORK_STATUS_LABELS[status]} ${progress.byStatus[status]}`).join(", ")}>
                {WORK_ITEM_STATUSES.map((status) => progress.byStatus[status]
                  ? <div key={status} className={WORK_STATUS_STYLES[status].dot} style={{ width: `${((progress.byStatus[status] ?? 0) / progress.total) * 100}%` }} />
                  : null)}
              </div>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-5 pt-2 pb-5 text-sm text-text-secondary sm:px-6">No child items yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border border-t border-border">
              {items.map((child) => (
                <li key={child.id} className={cn("relative flex items-center gap-3 px-5 py-3 hover:bg-surface-muted/50 sm:px-6", child.archivedAt && "opacity-60")}>
                  <WorkTypeIcon type={child.type} />
                  <IssueKey issueKey={child.issueKey} className="hidden sm:inline" />
                  <Link href={`/projects/${projectId}/work/${child.id}`} className="min-w-0 flex-1 truncate text-sm font-medium after:absolute after:inset-0 hover:text-primary-strong">{child.title}</Link>
                  <span className="hidden max-w-40 truncate text-xs text-text-secondary md:inline">{child.assigneeName ?? "Unassigned"}</span>
                  <WorkStatusBadge status={child.status} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
