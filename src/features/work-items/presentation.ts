// Relative imports keep this module loadable by the plain-Node unit tests.
import type { WorkItemStatus } from "./types";

/* Display rules for work items (Phase 8H Part 3). Pure; derived from real fields only. */

const DAY = 86_400_000;
const CLOSED: readonly WorkItemStatus[] = ["DONE", "CANCELLED"];

export type DueTone = "neutral" | "warning" | "danger";
export type DueState = { label: string; tone: DueTone } | null;

/** "Overdue by 2 days", "Due today", "Due tomorrow" or "Due in 5 days"; null without a due date or once closed. */
export function dueState(dueDate: string | null, status: WorkItemStatus, today: string): DueState {
  if (!dueDate || CLOSED.includes(status)) return null;
  const days = Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
  if (days < 0) return { label: `Overdue by ${-days} day${days === -1 ? "" : "s"}`, tone: "danger" };
  if (days === 0) return { label: "Due today", tone: "warning" };
  if (days === 1) return { label: "Due tomorrow", tone: "warning" };
  return { label: `Due in ${days} days`, tone: "neutral" };
}

export type ChildProgress = { total: number; done: number; percent: number; byStatus: Partial<Record<WorkItemStatus, number>> };

/** Progress of an item's children: archived and cancelled children do not count. */
export function childProgress(children: readonly { status: WorkItemStatus; archivedAt: string | null }[]): ChildProgress {
  const counted = children.filter((child) => !child.archivedAt && child.status !== "CANCELLED");
  const byStatus: Partial<Record<WorkItemStatus, number>> = {};
  for (const child of counted) byStatus[child.status] = (byStatus[child.status] ?? 0) + 1;
  const done = byStatus.DONE ?? 0;
  return { total: counted.length, done, byStatus, percent: counted.length ? Math.floor((done / counted.length) * 100) : 0 };
}

export const DUE_TEXT: Record<DueTone, string> = {
  neutral: "text-text-secondary",
  warning: "text-warning",
  danger: "text-danger",
};
