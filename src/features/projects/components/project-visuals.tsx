import { cn } from "@/lib/utils/cn";

import { formatDateRange } from "../format";
import { SCHEDULE_BAR, SCHEDULE_TEXT, type Schedule } from "../schedule";

/* Small presentational pieces shared by the projects list and project pages (Phase 8H Part 2). */

const TILE_SIZES = {
  sm: "size-9 rounded-lg text-[10px]",
  md: "size-11 rounded-xl text-xs",
  lg: "size-14 rounded-2xl text-sm",
} as const;

/** The project key as a soft orange tile: the project's visual identity. */
export function ProjectKeyTile({ projectKey, size = "md", className }: { projectKey: string; size?: keyof typeof TILE_SIZES; className?: string }) {
  return (
    <span aria-hidden="true" className={cn(
      "flex shrink-0 items-center justify-center bg-primary-soft font-mono font-bold tracking-tight text-primary-strong ring-1 ring-primary/15 ring-inset",
      TILE_SIZES[size], className,
    )}>
      {projectKey.slice(0, 4)}
    </span>
  );
}

/** Planned window with time elapsed and the deadline state; renders nothing useful without dates. */
export function ScheduleBar({ schedule, startDate, targetDate, className }: {
  schedule: Schedule;
  startDate: string | null;
  targetDate: string | null;
  className?: string;
}) {
  const range = formatDateRange(startDate, targetDate);
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-text-secondary">{range ?? "No dates set"}</span>
        {schedule.label && <span className={cn("shrink-0 font-medium", SCHEDULE_TEXT[schedule.tone])}>{schedule.label}</span>}
      </div>
      {schedule.elapsed !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-muted" role="img" aria-label={`${schedule.elapsed}% of the planned time has passed`}>
          <div className={cn("h-full rounded-full", SCHEDULE_BAR[schedule.tone])} style={{ width: `${Math.max(schedule.elapsed, 2)}%` }} />
        </div>
      )}
    </div>
  );
}
