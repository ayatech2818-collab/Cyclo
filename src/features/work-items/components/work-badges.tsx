import { Bug, CheckSquare, ListChecks, BookOpen, Zap, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils/cn";

import { TYPE_LABELS, WORK_STATUS_LABELS, type WorkItemStatus, type WorkItemType } from "../types";

const TYPE_STYLES: Record<WorkItemType, { icon: LucideIcon; className: string }> = {
  EPIC: { icon: Zap, className: "bg-primary/10 text-primary" },
  STORY: { icon: BookOpen, className: "bg-success/10 text-success" },
  TASK: { icon: CheckSquare, className: "bg-text-secondary/10 text-text-secondary" },
  SUBTASK: { icon: ListChecks, className: "bg-text-secondary/10 text-text-secondary" },
  BUG: { icon: Bug, className: "bg-danger/10 text-danger" },
};

/** Square type icon with an accessible label. */
export function WorkTypeIcon({ type, className }: { type: WorkItemType; className?: string }) {
  const { icon: Icon, className: tone } = TYPE_STYLES[type];
  return (
    <span title={TYPE_LABELS[type]} className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md", tone, className)}>
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={2.25} />
      <span className="sr-only">{TYPE_LABELS[type]}</span>
    </span>
  );
}

export function WorkTypeBadge({ type }: { type: WorkItemType }) {
  const { icon: Icon, className } = TYPE_STYLES[type];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", className)}>
      <Icon aria-hidden="true" className="size-3.5" />
      {TYPE_LABELS[type]}
    </span>
  );
}

const STATUS_STYLES: Record<WorkItemStatus, string> = {
  BACKLOG: "bg-surface-muted text-text-secondary",
  TODO: "bg-text-secondary/10 text-text-primary",
  IN_PROGRESS: "bg-primary/10 text-primary",
  IN_REVIEW: "bg-accent/10 text-accent",
  BLOCKED: "bg-danger/10 text-danger",
  DONE: "bg-success/10 text-success",
  CANCELLED: "bg-surface-muted text-text-muted line-through",
};

export function WorkStatusBadge({ status }: { status: WorkItemStatus }) {
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold tracking-wide whitespace-nowrap uppercase", STATUS_STYLES[status])}>
      {WORK_STATUS_LABELS[status]}
    </span>
  );
}

export function IssueKey({ issueKey, className }: { issueKey: string; className?: string }) {
  return <span className={cn("font-mono text-xs font-medium whitespace-nowrap text-text-secondary", className)}>{issueKey}</span>;
}
