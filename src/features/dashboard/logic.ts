// Relative imports keep this module loadable by the plain-Node unit tests.
import type { ProjectListItem } from "../projects/types";
import type { Sprint } from "../sprints/types";
import type { WorkItemListItem, WorkItemStatus } from "../work-items/types";

/* Pure helpers for the home dashboard (Phase 8H Part 1). */

export type AttentionReason = { kind: "on_hold" | "overdue" | "reviews_waiting"; label: string };

const DAY = 86_400_000;

/** Why a project needs attention, from its real state only. */
export function attentionReasons(
  project: Pick<ProjectListItem, "status" | "targetDate">, today: string, oldestReviewAt: string | null, now: number,
): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (project.status === "on_hold") reasons.push({ kind: "on_hold", label: "On hold" });
  if (project.targetDate && project.targetDate < today && project.status !== "completed" && project.status !== "cancelled") {
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${project.targetDate}T00:00:00Z`)) / DAY);
    reasons.push({ kind: "overdue", label: `Past target date by ${days} day${days === 1 ? "" : "s"}` });
  }
  if (oldestReviewAt) {
    const waiting = Math.floor((now - Date.parse(oldestReviewAt)) / DAY);
    if (waiting >= 3) reasons.push({ kind: "reviews_waiting", label: `Review waiting ${waiting} days` });
  }
  return reasons;
}

export function isOpenWork(item: Pick<WorkItemListItem, "status">): boolean {
  return item.status !== "DONE" && item.status !== "CANCELLED";
}

/** My work: what needs me first. */
export const MY_WORK_ORDER: Record<WorkItemStatus, number> = {
  BLOCKED: 0, IN_PROGRESS: 1, IN_REVIEW: 2, TODO: 3, BACKLOG: 4, DONE: 5, CANCELLED: 6,
};

/** Sprint completion by points when estimated, else by items (same rule as sprint progress). */
export function sprintCompletion(sprint: Pick<Sprint, "estimateTotal" | "doneEstimate" | "itemCount" | "doneCount">): number {
  if (sprint.estimateTotal > 0) return Math.floor((sprint.doneEstimate / sprint.estimateTotal) * 100);
  return sprint.itemCount > 0 ? Math.floor((sprint.doneCount / sprint.itemCount) * 100) : 0;
}

/** Whole days from today to the end date (negative when past); null without an end date. */
export function daysLeft(endDate: string | null, today: string): number | null {
  if (!endDate) return null;
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
}
