import { Bug, CheckSquare, ListChecks, BookOpen, Zap, type LucideIcon } from "lucide-react";

import { Badge, BADGE_BASE } from "@/components/ui/badge";
import { cn } from "@/lib/utils/cn";

import { TYPE_LABELS, WORK_STATUS_LABELS, type WorkItemStatus, type WorkItemType } from "../types";

/**
 * One colour per type (Phase 8H Part 3): epics purple (the accent), stories
 * green, tasks blue, subtasks neutral, bugs red. Icons carry the meaning too.
 */
const TYPE_STYLES: Record<WorkItemType, { icon: LucideIcon; className: string }> = {
  EPIC: { icon: Zap, className: "bg-accent/12 text-accent" },
  STORY: { icon: BookOpen, className: "bg-success/12 text-success" },
  TASK: { icon: CheckSquare, className: "bg-info/12 text-info" },
  SUBTASK: { icon: ListChecks, className: "bg-text-secondary/12 text-text-secondary" },
  BUG: { icon: Bug, className: "bg-danger/12 text-danger" },
};

const ICON_SIZES = {
  sm: { box: "size-6 rounded-md", icon: "size-3.5" },
  md: { box: "size-8 rounded-lg", icon: "size-4" },
  lg: { box: "size-10 rounded-xl", icon: "size-5" },
} as const;

/** Square type icon with an accessible label. */
export function WorkTypeIcon({ type, size = "sm", className }: { type: WorkItemType; size?: keyof typeof ICON_SIZES; className?: string }) {
  const { icon: Icon, className: tone } = TYPE_STYLES[type];
  const box = ICON_SIZES[size];
  return (
    <span title={TYPE_LABELS[type]} className={cn("inline-flex shrink-0 items-center justify-center", box.box, tone, className)}>
      <Icon aria-hidden="true" className={box.icon} strokeWidth={2.25} />
      <span className="sr-only">{TYPE_LABELS[type]}</span>
    </span>
  );
}

export function WorkTypeBadge({ type }: { type: WorkItemType }) {
  const { icon, className } = TYPE_STYLES[type];
  return <Badge icon={icon} className={className}>{TYPE_LABELS[type]}</Badge>;
}

/**
 * Workflow status colours come from the status-* theme roles (globals.css),
 * the same roles the board columns use.
 */
export const WORK_STATUS_STYLES: Record<WorkItemStatus, { pill: string; dot: string }> = {
  BACKLOG: { pill: "bg-surface-muted text-status-backlog", dot: "bg-status-backlog" },
  TODO: { pill: "bg-status-todo/10 text-text-primary", dot: "bg-status-todo" },
  IN_PROGRESS: { pill: "bg-status-progress/10 text-status-progress", dot: "bg-status-progress" },
  IN_REVIEW: { pill: "bg-status-review/10 text-status-review", dot: "bg-status-review" },
  BLOCKED: { pill: "bg-status-blocked/10 text-status-blocked", dot: "bg-status-blocked" },
  DONE: { pill: "bg-status-done/10 text-status-done", dot: "bg-status-done" },
  CANCELLED: { pill: "bg-surface-muted text-text-muted line-through", dot: "bg-text-muted" },
};

export function WorkStatusBadge({ status }: { status: WorkItemStatus }) {
  const style = WORK_STATUS_STYLES[status];
  return (
    <span className={cn(BADGE_BASE, "font-semibold", style.pill)}>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", style.dot)} />
      {WORK_STATUS_LABELS[status]}
    </span>
  );
}

export function IssueKey({ issueKey, className }: { issueKey: string; className?: string }) {
  return <span className={cn("font-mono text-xs font-medium whitespace-nowrap text-text-secondary", className)}>{issueKey}</span>;
}
