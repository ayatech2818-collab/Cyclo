"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { BadgeCheck, OctagonAlert, Play, RotateCcw, SendHorizontal, StepForward, Archive, ArchiveRestore, ArrowRight, ArrowUpDown, CalendarCheck2, CalendarPlus, CalendarX2, Gauge, IterationCw, PlayCircle, Undo2, CircleDot, FilePlus2, FolderPlus, GitBranch, Flag, History, Loader2, MessageSquare, MessageSquareX, Pencil, Shapes, UserCheck, UserCog, UserMinus, UserPlus, type LucideIcon } from "lucide-react";

import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { cn } from "@/lib/utils/cn";

import { loadMoreActivityAction } from "../actions";
import {
  ACTIVITY_TONES,
  activityDetails,
  actorLabel,
  describeActivity,
  formatActivityDateTime,
  formatActivityTime,
  groupActivityByDay,
  relativeTime,
  type ActivityAction,
  type ActivityCursor,
  type ActivityEntry,
  type ActivityTone,
} from "../activity";
import { secondaryButton } from "./styles";

const ICONS: Record<ActivityAction, LucideIcon> = {
  PROJECT_CREATED: FolderPlus,
  PROJECT_UPDATED: Pencil,
  PROJECT_MANAGER_CHANGED: UserCog,
  PROJECT_ARCHIVED: Archive,
  PROJECT_RESTORED: ArchiveRestore,
  PROJECT_MEMBER_ADDED: UserPlus,
  PROJECT_MEMBER_REMOVED: UserMinus,
  WORK_ITEM_CREATED: FilePlus2,
  WORK_ITEM_UPDATED: Pencil,
  WORK_ITEM_TYPE_CHANGED: Shapes,
  WORK_ITEM_PARENT_CHANGED: GitBranch,
  WORK_ITEM_ASSIGNED: UserCheck,
  WORK_ITEM_PRIORITY_CHANGED: Flag,
  WORK_ITEM_STATUS_CHANGED: CircleDot,
  WORK_ITEM_ARCHIVED: Archive,
  WORK_ITEM_RESTORED: ArchiveRestore,
  WORK_ITEM_REORDERED: ArrowUpDown,
  WORK_ITEM_ADDED_TO_SPRINT: IterationCw,
  WORK_ITEM_REMOVED_FROM_SPRINT: Undo2,
  WORK_ITEM_MOVED_BETWEEN_SPRINTS: IterationCw,
  WORK_ITEM_STARTED: Play,
  WORK_ITEM_SUBMITTED_FOR_REVIEW: SendHorizontal,
  WORK_ITEM_REVIEW_APPROVED: BadgeCheck,
  WORK_ITEM_REVIEW_REJECTED: RotateCcw,
  WORK_ITEM_BLOCKED: OctagonAlert,
  WORK_ITEM_RESUMED: StepForward,
  WORK_ITEM_COMMENT_ADDED: MessageSquare,
  WORK_ITEM_COMMENT_EDITED: MessageSquare,
  WORK_ITEM_COMMENT_DELETED: MessageSquareX,
  SPRINT_CREATED: CalendarPlus,
  SPRINT_UPDATED: Pencil,
  SPRINT_CAPACITY_CHANGED: Gauge,
  SPRINT_STARTED: PlayCircle,
  SPRINT_COMPLETED: CalendarCheck2,
  SPRINT_CANCELLED: CalendarX2,
};

const TONE_CLASSES: Record<ActivityTone, string> = {
  primary: "bg-action text-primary-foreground",
  accent: "bg-accent text-accent-foreground",
  success: "bg-success text-surface",
  warning: "bg-warning text-surface",
  danger: "bg-danger text-danger-foreground",
  neutral: "bg-text-secondary text-surface",
};

/**
 * Before hydration everything renders in UTC (identical on server and client);
 * after mount, dates switch to the viewer's time zone and relative times appear.
 */
function subscribeToMinutes(onTick: () => void) {
  const timer = setInterval(onTick, 30_000);
  return () => clearInterval(timer);
}
const currentMinute = () => Math.floor(Date.now() / 60_000);
const serverMinute = () => null;

export function useViewerClock() {
  // null during server render and hydration, then the current minute.
  const minute = useSyncExternalStore(subscribeToMinutes, currentMinute, serverMinute);
  // End of the current minute, so entries from the last few seconds never look "in the future".
  const now = minute === null ? null : new Date((minute + 1) * 60_000);
  return { now, timeZone: now ? undefined : "UTC" };
}

function ActivityItem({ entry, now, timeZone, last, projectId, showWorkItem }: {
  entry: ActivityEntry;
  now: Date | null;
  timeZone: string | undefined;
  last: boolean;
  projectId: string;
  showWorkItem: boolean;
}) {
  const Icon = ICONS[entry.action];
  const details = activityDetails(entry);
  const relative = now ? relativeTime(entry.createdAt, now) : null;
  const actor = actorLabel(entry);

  return (
    <li className="relative flex gap-3 pb-6 sm:gap-4">
      {!last && <span aria-hidden="true" className="absolute top-11 bottom-1 left-[1.1875rem] w-px bg-border" />}
      <div className="relative shrink-0">
        <EmployeeAvatar fullName={entry.actorName} email={null} avatarUrl={null} avatar={entry.actorAvatar} size="md" />
        <span className={cn("absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full ring-2 ring-surface", TONE_CLASSES[ACTIVITY_TONES[entry.action]])}>
          <Icon aria-hidden="true" className="size-3" strokeWidth={2.5} />
        </span>
      </div>

      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <p className="text-sm text-text-secondary">
            <span className="font-semibold text-text-primary">{actor}</span> {describeActivity(entry)}
            {entry.action === "PROJECT_CREATED" && entry.changes.some((change) => change.field === "name") && (
              <> “<span className="text-text-primary">{entry.changes.find((change) => change.field === "name")?.to}</span>”</>
            )}
          </p>
          <time dateTime={entry.createdAt} title={formatActivityDateTime(entry.createdAt, timeZone)} className="shrink-0 text-xs whitespace-nowrap text-text-muted">
            {formatActivityTime(entry.createdAt, timeZone)}
            {timeZone === "UTC" && " UTC"}
            {relative && <span className="hidden sm:inline"> · {relative}</span>}
          </time>
        </div>

        {showWorkItem && entry.workItem && (
          <Link
            href={`/projects/${projectId}/work/${entry.workItem.id}`}
            className="mt-1.5 inline-flex max-w-full items-center gap-2 rounded-md px-1 text-sm hover:bg-surface-muted"
          >
            <span className="font-mono text-xs text-text-muted">{entry.workItem.issueKey}</span>
            <span className="truncate font-medium text-text-primary">{entry.workItem.title}</span>
          </Link>
        )}

        {showWorkItem && !entry.workItem && entry.sprint && (
          <Link href={`/projects/${projectId}/sprints/${entry.sprint.id}`} className="mt-1.5 inline-flex max-w-full items-center gap-2 rounded-md px-1 text-sm hover:bg-surface-muted">
            <IterationCw aria-hidden="true" className="size-3.5 text-text-muted" />
            <span className="truncate font-medium text-text-primary">{entry.sprint.name}</span>
          </Link>
        )}

        {details.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {details.map((detail) => (
              <li key={detail.label} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-muted/60 px-2 py-1 text-xs">
                <span className="text-text-muted">{detail.label}</span>
                {detail.from !== null && (
                  <>
                    <span className="truncate text-text-secondary line-through decoration-text-muted/60">{detail.from}</span>
                    <ArrowRight aria-label="changed to" className="size-3 shrink-0 text-text-muted" />
                  </>
                )}
                <span className="truncate font-medium text-text-primary">{detail.to}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

export function ActivityFeed({ projectId, workItemId = null, initialEntries, initialCursor, emptyText }: {
  projectId: string;
  /** When set, the feed shows (and pages through) one work item's history. */
  workItemId?: string | null;
  initialEntries: ActivityEntry[];
  initialCursor: ActivityCursor | null;
  emptyText?: string;
}) {
  const [entries, setEntries] = useState(initialEntries);
  const [cursor, setCursor] = useState(initialCursor);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { now, timeZone } = useViewerClock();

  const loadMore = () => {
    if (!cursor) return;
    setError(null);
    startTransition(async () => {
      const result = await loadMoreActivityAction(projectId, cursor, workItemId);
      if (!result.page) {
        setError(result.error);
        return;
      }
      const page = result.page;
      // Keyset paging never overlaps; the id check guards against double clicks.
      setEntries((current) => {
        const seen = new Set(current.map((entry) => entry.id));
        return [...current, ...page.entries.filter((entry) => !seen.has(entry.id))];
      });
      setCursor(page.nextCursor);
    });
  };

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 py-14 text-center">
        <span className="mb-4 rounded-full bg-primary/10 p-3 text-primary">
          <History aria-hidden="true" className="size-6" />
        </span>
        <p className="text-base font-semibold">No activity yet</p>
        <p className="mt-1 max-w-sm text-sm text-text-secondary">{emptyText ?? "Changes to this project, its team and its work will appear here."}</p>
      </div>
    );
  }

  // Before mount, an epoch "now" yields full dates only (no Today/Yesterday), so server and client agree.
  const groups = groupActivityByDay(entries, now ?? new Date(0), timeZone);

  return (
    <div className="p-5 sm:p-6">
      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.key} aria-labelledby={`activity-day-${group.key}`}>
            <h3 id={`activity-day-${group.key}`} className="mb-4 text-xs font-semibold tracking-wide text-text-muted uppercase">
              {group.label}
            </h3>
            <ol>
              {group.entries.map((entry, index) => (
                <ActivityItem
                  key={entry.id}
                  entry={entry}
                  now={now}
                  timeZone={timeZone}
                  last={index === group.entries.length - 1}
                  projectId={projectId}
                  showWorkItem={!workItemId}
                />
              ))}
            </ol>
          </section>
        ))}
      </div>

      <div className="mt-2 flex flex-col items-center gap-2 border-t border-border pt-5" aria-live="polite">
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {cursor ? (
          <button type="button" onClick={loadMore} disabled={pending} className={secondaryButton}>
            {pending && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
            {pending ? "Loading…" : "Load older activity"}
          </button>
        ) : (
          <p className="text-xs text-text-muted">You’ve reached the beginning of this project’s history.</p>
        )}
      </div>
    </div>
  );
}
