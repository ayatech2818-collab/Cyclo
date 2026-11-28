import type { ReactNode } from "react";
import Link from "next/link";
import { Archive, ArrowLeft, ChevronRight } from "lucide-react";

import { panel } from "@/components/ui/styles";
import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { ProjectPriorityBadge } from "@/features/projects/components/project-badges";
import { formatProjectDate } from "@/features/projects/format";
import { cn } from "@/lib/utils/cn";

import { DUE_TEXT, dueState, type ChildProgress } from "../presentation";
import type { WorkItemDetail } from "../types";
import { formatEstimate } from "../validation";
import { IssueKey, WorkTypeBadge, WorkTypeIcon } from "./work-badges";

/* Work item page header (Phase 8H Part 3): hierarchy path, title, key facts, then the status actions. */

/** Work › parent › this item. */
export function WorkItemTrail({ projectId, item }: { projectId: string; item: WorkItemDetail }) {
  return (
    <nav aria-label="Work item hierarchy" className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-text-secondary">
      <Link href={`/projects/${projectId}/work`} className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 font-medium hover:bg-surface-muted hover:text-text-primary">
        <ArrowLeft aria-hidden="true" className="size-4" />
        Work
      </Link>
      {item.parent && (
        <>
          <ChevronRight aria-hidden="true" className="size-4 text-text-muted" />
          <Link href={`/projects/${projectId}/work/${item.parent.id}`} title={item.parent.title}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 hover:bg-surface-muted hover:text-text-primary">
            <WorkTypeIcon type={item.parent.type} className="size-5" />
            <span className="sr-only">Parent: </span>
            <span className="font-mono text-xs">{item.parent.issueKey}</span>
            <span className="hidden max-w-56 truncate sm:inline">{item.parent.title}</span>
          </Link>
        </>
      )}
      <ChevronRight aria-hidden="true" className="size-4 text-text-muted" />
      <span aria-current="page" className="px-1 font-mono text-xs font-medium text-text-primary">{item.issueKey}</span>
    </nav>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-text-muted">{term}</dt>
      <dd className="mt-1 min-w-0 text-sm font-medium">{children}</dd>
    </div>
  );
}

/**
 * Title block with the facts people look for first (priority, assignee,
 * estimate or child progress, due date). `actions` (the status control)
 * sits directly underneath, so it is near the top on every screen size.
 */
export function WorkItemHeader({ item, progress, today, actions }: {
  item: WorkItemDetail;
  progress: ChildProgress;
  today: string;
  actions: ReactNode;
}) {
  const due = dueState(item.dueDate, item.status, today);
  const estimate = formatEstimate(item.estimate);
  const muted = (text: string) => <span className="font-normal text-text-muted">{text}</span>;

  return (
    <header className={cn(panel, "overflow-hidden")}>
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <WorkTypeIcon type={item.type} size="lg" className="hidden sm:inline-flex" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <WorkTypeBadge type={item.type} />
              <IssueKey issueKey={item.issueKey} className="text-sm" />
              {item.archivedAt && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-text-secondary">
                  <Archive aria-hidden="true" className="size-3.5" />Archived
                </span>
              )}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight break-words sm:text-3xl">{item.title}</h1>
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
          <Fact term="Priority"><ProjectPriorityBadge priority={item.priority} /></Fact>
          <Fact term="Assignee">
            {item.assigneeName ? (
              <span className="flex min-w-0 items-center gap-2">
                <EmployeeAvatar fullName={item.assigneeName} email={item.assigneeEmail} avatarUrl={null} size="sm" />
                <span className="truncate">{item.assigneeName}</span>
              </span>
            ) : muted("Unassigned")}
          </Fact>
          {item.type === "EPIC" ? (
            <Fact term="Children done">{progress.total ? `${progress.done} of ${progress.total} · ${progress.percent}%` : muted("No children")}</Fact>
          ) : (
            <Fact term="Estimate">{estimate ?? muted("Not estimated")}</Fact>
          )}
          <Fact term="Due">
            {formatProjectDate(item.dueDate) ?? muted("No due date")}
            {due && due.tone !== "neutral" && <span className={cn("block text-xs", DUE_TEXT[due.tone])}>{due.label}</span>}
          </Fact>
        </dl>
      </div>

      <section aria-label="Status and actions" className="space-y-3 border-t border-border bg-surface-muted/40 px-5 py-4 sm:px-6">
        {actions}
      </section>
    </header>
  );
}
