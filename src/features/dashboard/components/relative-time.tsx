"use client";

import { formatActivityDateTime, relativeTime } from "@/features/projects/activity";
import { useViewerClock } from "@/features/projects/components/project-activity";

/** "5 minutes ago" in the viewer's clock; a UTC date until hydration (no mismatch). */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const { now, timeZone } = useViewerClock();
  const relative = now ? relativeTime(iso, now) : null;
  return (
    <time dateTime={iso} title={formatActivityDateTime(iso, timeZone)} className={className}>
      {relative ?? `${formatActivityDateTime(iso, timeZone)}${timeZone === "UTC" ? " UTC" : ""}`}
    </time>
  );
}
