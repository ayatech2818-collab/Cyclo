import type { ProjectStatus } from "./types";

/*
 * Project timeline (Phase 8H Part 2), derived only from the project's own
 * start date, target date and status. Pure and framework-free.
 */

export type ScheduleTone = "neutral" | "success" | "warning" | "danger";

export type Schedule = {
  /** Share of the planned start → target window that has passed (0–100), or null without both dates. */
  elapsed: number | null;
  /** Short state, e.g. "12 days left", "Due today", "Overdue by 3 days"; null without a target date. */
  label: string | null;
  tone: ScheduleTone;
};

const DAY = 86_400_000;
const SOON_DAYS = 14;

const dayValue = (date: string) => Date.parse(`${date}T00:00:00Z`);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function projectSchedule(
  project: { status: ProjectStatus; startDate: string | null; targetDate: string | null },
  today: string,
): Schedule {
  const now = dayValue(today);
  let elapsed: number | null = null;
  if (project.startDate && project.targetDate) {
    const start = dayValue(project.startDate);
    const end = dayValue(project.targetDate);
    if (end > start) elapsed = Math.round(Math.min(1, Math.max(0, (now - start) / (end - start))) * 100);
  }

  if (project.status === "completed") return { elapsed: elapsed === null ? null : 100, label: "Completed", tone: "success" };
  if (project.status === "cancelled") return { elapsed, label: "Cancelled", tone: "neutral" };
  if (!project.targetDate) return { elapsed, label: null, tone: "neutral" };

  const days = Math.round((dayValue(project.targetDate) - now) / DAY);
  if (days < 0) return { elapsed, label: `Overdue by ${plural(-days, "day")}`, tone: "danger" };
  if (days === 0) return { elapsed, label: "Due today", tone: "warning" };
  if (project.startDate && dayValue(project.startDate) > now) {
    return { elapsed, label: `Starts in ${plural(Math.round((dayValue(project.startDate) - now) / DAY), "day")}`, tone: "neutral" };
  }
  return { elapsed, label: `${plural(days, "day")} left`, tone: days <= SOON_DAYS ? "warning" : "neutral" };
}

export const SCHEDULE_TEXT: Record<ScheduleTone, string> = {
  neutral: "text-text-secondary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export const SCHEDULE_BAR: Record<ScheduleTone, string> = {
  neutral: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};
