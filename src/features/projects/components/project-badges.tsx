import { Archive, ArrowDown, ArrowUp, ChevronsUp, Minus } from "lucide-react";

import { cn } from "@/lib/utils/cn";

import { PRIORITY_LABELS, STATUS_LABELS, type ProjectPriority, type ProjectStatus } from "../types";

const badge = "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap";

const statusStyles: Record<ProjectStatus, { pill: string; dot: string }> = {
  planning: { pill: "bg-text-secondary/10 text-text-secondary", dot: "bg-text-muted" },
  active: { pill: "bg-success/10 text-success", dot: "bg-success" },
  on_hold: { pill: "bg-warning/10 text-warning", dot: "bg-warning" },
  completed: { pill: "bg-primary/10 text-primary", dot: "bg-primary" },
  cancelled: { pill: "bg-danger/10 text-danger", dot: "bg-danger" },
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const style = statusStyles[status];
  return (
    <span className={cn(badge, style.pill)}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", style.dot)} />
      {STATUS_LABELS[status]}
    </span>
  );
}

const priorityStyles: Record<ProjectPriority, { className: string; icon: typeof Minus }> = {
  low: { className: "text-text-secondary", icon: ArrowDown },
  medium: { className: "text-primary", icon: Minus },
  high: { className: "text-accent", icon: ArrowUp },
  critical: { className: "bg-accent/10 text-accent", icon: ChevronsUp },
};

export function ProjectPriorityBadge({ priority }: { priority: ProjectPriority }) {
  const { className, icon: Icon } = priorityStyles[priority];
  return (
    <span className={cn(badge, "border border-border px-2", className)}>
      <Icon aria-hidden="true" className="size-3.5" />
      <span>
        <span className="sr-only">Priority: </span>
        {PRIORITY_LABELS[priority]}
      </span>
    </span>
  );
}

export function ProjectKeyBadge({ projectKey, className }: { projectKey: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-md bg-accent/10 px-2 py-0.5 font-mono text-xs font-semibold tracking-wide text-accent", className)}>
      {projectKey}
    </span>
  );
}

export function ArchivedBadge() {
  return (
    <span className={cn(badge, "bg-surface-muted text-text-secondary")}>
      <Archive aria-hidden="true" className="size-3.5" />
      Archived
    </span>
  );
}
