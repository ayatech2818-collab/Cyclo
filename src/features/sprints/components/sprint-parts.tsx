import Link from "next/link";
import { AlertTriangle, CalendarDays, Target } from "lucide-react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { formatProjectDate } from "@/features/projects/format";
import { cn } from "@/lib/utils/cn";

import { capacityState, formatPoints, sprintDurationDays } from "../logic";
import { SPRINT_STATUS_LABELS, type Sprint, type SprintStatus } from "../types";

const STATUS_TONES: Record<SprintStatus, BadgeTone> = {
  PLANNING: "muted",
  ACTIVE: "accent",
  COMPLETED: "success",
  CANCELLED: "danger",
};

export function SprintStatusBadge({ status }: { status: SprintStatus }) {
  return (
    <Badge tone={STATUS_TONES[status]} dot={status === "ACTIVE"} pulse={status === "ACTIVE"} className="font-semibold">
      {SPRINT_STATUS_LABELS[status]}
    </Badge>
  );
}

export function SprintDates({ sprint, className }: { sprint: Pick<Sprint, "startDate" | "endDate">; className?: string }) {
  const days = sprintDurationDays(sprint.startDate, sprint.endDate);
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-text-secondary", className)}>
      <CalendarDays aria-hidden="true" className="size-3.5" />
      {sprint.startDate || sprint.endDate
        ? <>{formatProjectDate(sprint.startDate) ?? "No start"} → {formatProjectDate(sprint.endDate) ?? "No end"}{days !== null && <span className="text-text-muted"> · {days} days</span>}</>
        : <span className="text-text-muted">Dates not set</span>}
    </span>
  );
}

/** Planned points against the manager-set capacity. A warning, never a block. */
export function CapacityMeter({ planned, capacity, compact = false }: { planned: number; capacity: number | null; compact?: boolean }) {
  const state = capacityState(planned, capacity);
  const percent = state.kind === "unset" ? 0 : Math.min(100, Math.round((Number.isFinite(state.ratio) ? state.ratio : 1) * 100));
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-text-secondary">
          <span className="font-semibold text-text-primary tabular-nums">{formatPoints(planned)}</span>
          {state.kind === "unset" ? " pts planned" : <> / {formatPoints(state.capacity)} pts capacity</>}
        </span>
        {state.kind === "over" && (
          <span className="inline-flex items-center gap-1 font-medium text-warning"><AlertTriangle aria-hidden="true" className="size-3.5" />Over by {formatPoints(state.overBy)}</span>
        )}
        {state.kind === "unset" && !compact && <span className="text-text-muted">No capacity set</span>}
      </div>
      {state.kind !== "unset" && (
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted" role="meter" aria-valuemin={0} aria-valuemax={state.capacity} aria-valuenow={planned} aria-label="Planned points against capacity">
          <div className={cn("h-full rounded-full", state.kind === "over" ? "bg-warning" : "bg-primary")} style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}

export function SprintCard({ projectId, sprint, highlight = false }: { projectId: string; sprint: Sprint; highlight?: boolean }) {
  const progress = sprint.itemCount ? Math.round((sprint.doneCount / sprint.itemCount) * 100) : 0;
  return (
    <Link
      href={`/projects/${projectId}/sprints/${sprint.id}`}
      className={cn(
        "group flex flex-col gap-3 rounded-xl border bg-surface p-4 shadow-sm transition-colors hover:border-primary/40",
        highlight ? "border-accent/40 ring-1 ring-accent/20" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold group-hover:text-primary">{sprint.name}</h3>
          <SprintDates sprint={sprint} className="mt-1" />
        </div>
        <SprintStatusBadge status={sprint.status} />
      </div>
      {sprint.goal && (
        <p className="line-clamp-2 flex gap-1.5 text-xs text-text-secondary"><Target aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-text-muted" />{sprint.goal}</p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
        <span><span className="font-semibold text-text-primary tabular-nums">{sprint.itemCount}</span> items</span>
        {sprint.unestimatedCount > 0 && <span>{sprint.unestimatedCount} unestimated</span>}
        {sprint.status !== "PLANNING" && sprint.status !== "CANCELLED" && <span>{sprint.doneCount}/{sprint.itemCount} done · {progress}%</span>}
      </div>
      {sprint.status !== "CANCELLED" && <CapacityMeter planned={sprint.estimateTotal} capacity={sprint.capacity} compact />}
    </Link>
  );
}
