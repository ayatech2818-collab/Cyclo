import type { ResolvedAvatar } from "@/features/profile/avatar";

// Relative imports keep this module loadable by the plain-Node unit tests.
import { isEmojiAvatarId, isIconAvatarId } from "../profile/avatar-catalog";
import { TYPE_LABELS, WORK_STATUS_LABELS } from "../work-items/types";
import { isWorkItemStatus, isWorkItemType } from "../work-items/validation";
import { ProjectError } from "./errors";
import { formatProjectDate } from "./format";
import { PRIORITY_LABELS, STATUS_LABELS } from "./types";
import { isProjectPriority, isProjectStatus, isUuid } from "./validation";

/*
 * Project activity feed (Phases 8C/8D): row parsing, human-readable wording and
 * date grouping. Pure and framework-free. The database returns only
 * allow-listed, display-safe fields (see list_project_activity).
 */

export const ACTIVITY_ACTIONS = [
  "PROJECT_CREATED",
  "PROJECT_UPDATED",
  "PROJECT_MANAGER_CHANGED",
  "PROJECT_ARCHIVED",
  "PROJECT_RESTORED",
  "PROJECT_MEMBER_ADDED",
  "PROJECT_MEMBER_REMOVED",
  "WORK_ITEM_CREATED",
  "WORK_ITEM_UPDATED",
  "WORK_ITEM_TYPE_CHANGED",
  "WORK_ITEM_PARENT_CHANGED",
  "WORK_ITEM_ASSIGNED",
  "WORK_ITEM_PRIORITY_CHANGED",
  "WORK_ITEM_STATUS_CHANGED",
  "WORK_ITEM_ARCHIVED",
  "WORK_ITEM_RESTORED",
  "WORK_ITEM_REORDERED",
  "WORK_ITEM_ADDED_TO_SPRINT",
  "WORK_ITEM_REMOVED_FROM_SPRINT",
  "WORK_ITEM_MOVED_BETWEEN_SPRINTS",
  "WORK_ITEM_STARTED",
  "WORK_ITEM_SUBMITTED_FOR_REVIEW",
  "WORK_ITEM_REVIEW_APPROVED",
  "WORK_ITEM_REVIEW_REJECTED",
  "WORK_ITEM_BLOCKED",
  "WORK_ITEM_RESUMED",
  "WORK_ITEM_COMMENT_ADDED",
  "WORK_ITEM_COMMENT_EDITED",
  "WORK_ITEM_COMMENT_DELETED",
  "SPRINT_CREATED",
  "SPRINT_UPDATED",
  "SPRINT_CAPACITY_CHANGED",
  "SPRINT_STARTED",
  "SPRINT_COMPLETED",
  "SPRINT_CANCELLED",
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export const ACTIVITY_FIELDS = [
  "name", "project_key", "title", "type", "status", "priority", "start_date", "target_date", "due_date", "estimate", "description",
  "end_date", "capacity_points", "goal", "completed_items", "carried_over", "returned_items", "reason",
] as const;
export type ActivityField = (typeof ACTIVITY_FIELDS)[number];

export type ActivityChange = { field: ActivityField; from: string | null; to: string | null };

export type ActivityCursor = { createdAt: string; id: string };

export type ActivityEntry = {
  id: string;
  action: ActivityAction;
  createdAt: string;
  actorId: string;
  actorName: string | null;
  /** Resolved on the server (photo for SA/PM viewers, emoji/icon choice otherwise). */
  actorAvatar: ResolvedAvatar;
  subjectName: string | null;
  previousSubjectName: string | null;
  changes: ActivityChange[];
  /** Set for WORK_ITEM_* events. */
  workItem: { id: string; issueKey: string; title: string } | null;
  /** Set for sprint events and sprint membership events. */
  sprint: { id: string; name: string } | null;
};

export type ActivityPage = { entries: ActivityEntry[]; nextCursor: ActivityCursor | null };

export const ACTIVITY_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Parsing (fails closed on malformed rows)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProjectError("unexpected");
  return value as Row;
}

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new ProjectError("unexpected");
  return value;
}

function optionalStr(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ProjectError("unexpected");
  return value;
}

function isActivityAction(value: unknown): value is ActivityAction {
  return typeof value === "string" && (ACTIVITY_ACTIONS as readonly string[]).includes(value);
}

function isActivityField(value: unknown): value is ActivityField {
  return typeof value === "string" && (ACTIVITY_FIELDS as readonly string[]).includes(value);
}

function parseChanges(value: unknown): ActivityChange[] {
  if (!Array.isArray(value)) throw new ProjectError("unexpected");
  const changes: ActivityChange[] = [];
  for (const item of value) {
    const change = asRow(item);
    // Unknown fields are ignored rather than displayed.
    if (!isActivityField(change.field)) continue;
    const pick = (key: "from" | "to") => (typeof change[key] === "string" ? (change[key] as string) : null);
    changes.push({ field: change.field, from: pick("from"), to: pick("to") });
  }
  return changes;
}

/** Avatar from the allow-listed emoji/icon choice returned by the activity RPC. */
export function fallbackActorAvatar(kind: unknown, symbol: unknown): ResolvedAvatar {
  if (kind === "emoji" && isEmojiAvatarId(symbol)) return { type: "emoji", id: symbol };
  if (kind === "icon" && isIconAvatarId(symbol)) return { type: "icon", id: symbol };
  return { type: "initials" };
}

/** Parses one list_project_activity row. Returns null for event types this UI does not know. */
export function toActivityEntry(value: unknown, avatars: ReadonlyMap<string, ResolvedAvatar> = new Map()): ActivityEntry | null {
  const row = asRow(value);
  if (!isActivityAction(row.action)) return null;
  const actorId = str(row, "actor_id");
  if (!isUuid(actorId)) throw new ProjectError("unexpected");
  const created = str(row, "created_at");
  if (Number.isNaN(new Date(created).getTime())) throw new ProjectError("unexpected");
  return {
    id: str(row, "id"),
    action: row.action,
    createdAt: created,
    actorId,
    actorName: optionalStr(row, "actor_name"),
    actorAvatar: avatars.get(actorId) ?? fallbackActorAvatar(row.actor_avatar_kind, row.actor_avatar_symbol),
    subjectName: optionalStr(row, "subject_name"),
    previousSubjectName: optionalStr(row, "previous_subject_name"),
    changes: parseChanges(row.changes),
    workItem: parseWorkItem(row),
    sprint: parseSprint(row),
  };
}

function parseSprint(row: Row): ActivityEntry["sprint"] {
  const id = optionalStr(row, "sprint_id");
  const name = optionalStr(row, "sprint_name");
  if (!id || !name) return null;
  if (!isUuid(id)) throw new ProjectError("unexpected");
  return { id, name };
}

function parseWorkItem(row: Row): ActivityEntry["workItem"] {
  const id = optionalStr(row, "work_item_id");
  if (!id) return null;
  if (!isUuid(id)) throw new ProjectError("unexpected");
  const issueKey = optionalStr(row, "work_item_key");
  const title = optionalStr(row, "work_item_title");
  return issueKey && title ? { id, issueKey, title } : null;
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

export const FIELD_LABELS: Record<ActivityField, string> = {
  name: "Name",
  project_key: "Key",
  status: "Status",
  priority: "Priority",
  start_date: "Start date",
  target_date: "Target date",
  title: "Title",
  type: "Type",
  due_date: "Due date",
  estimate: "Estimate",
  description: "Description",
  end_date: "End date",
  capacity_points: "Capacity",
  goal: "Goal",
  completed_items: "Completed items",
  carried_over: "Carried over",
  returned_items: "Returned to backlog",
  reason: "Reason",
};

function displayValue(field: ActivityField, value: string | null): string {
  if (value === null || value === "") return "Not set";
  if (field === "status" && isProjectStatus(value)) return STATUS_LABELS[value];
  if (field === "status" && isWorkItemStatus(value)) return WORK_STATUS_LABELS[value];
  if (field === "type" && isWorkItemType(value)) return TYPE_LABELS[value];
  if (field === "priority" && isProjectPriority(value)) return PRIORITY_LABELS[value];
  if (field === "start_date" || field === "target_date" || field === "due_date" || field === "end_date") return formatProjectDate(value) ?? value;
  if (field === "capacity_points") return `${Number(value)} pts`;
  return value;
}

const SINGLE_FIELD_PHRASES: Record<ActivityField, string> = {
  name: "renamed the project",
  project_key: "changed the project key",
  status: "changed the status",
  priority: "changed the priority",
  start_date: "changed the start date",
  target_date: "changed the target date",
  title: "renamed",
  type: "changed the type of",
  due_date: "changed the due date of",
  estimate: "changed the estimate of",
  description: "updated the project description",
  end_date: "changed the end date",
  capacity_points: "changed the capacity",
  goal: "updated the goal",
  completed_items: "completed",
  carried_over: "carried over work",
  returned_items: "returned work",
  reason: "updated the reason",
};

const WORK_FIELD_PHRASES: Partial<Record<ActivityField, string>> = {
  title: "renamed",
  description: "updated the description of",
  start_date: "changed the start date of",
  due_date: "changed the due date of",
  estimate: "changed the estimate of",
};

export function actorLabel(entry: Pick<ActivityEntry, "actorName">): string {
  return entry.actorName?.trim() || "A former employee";
}

/** The predicate after the actor's name, e.g. "added Dev Kumar to the team". */
export function describeActivity(entry: Pick<ActivityEntry, "action" | "subjectName" | "previousSubjectName" | "changes" | "workItem"> & { sprint?: ActivityEntry["sprint"] }): string {
  const subject = entry.subjectName?.trim() || "a former employee";
  const item = entry.workItem?.issueKey ?? "a work item";
  switch (entry.action) {
    case "PROJECT_CREATED":
      return "created the project";
    case "PROJECT_UPDATED":
      return entry.changes.length === 1 ? SINGLE_FIELD_PHRASES[entry.changes[0].field] : "updated the project";
    case "PROJECT_MANAGER_CHANGED":
      return entry.previousSubjectName
        ? `changed the Project Manager from ${entry.previousSubjectName} to ${subject}`
        : `made ${subject} the Project Manager`;
    case "PROJECT_ARCHIVED":
      return "archived the project";
    case "PROJECT_RESTORED":
      return "restored the project";
    case "PROJECT_MEMBER_ADDED":
      return `added ${subject} to the team`;
    case "PROJECT_MEMBER_REMOVED":
      return `removed ${subject} from the team`;
    case "WORK_ITEM_CREATED":
      return `created ${item}`;
    case "WORK_ITEM_UPDATED": {
      const phrase = entry.changes.length === 1 ? WORK_FIELD_PHRASES[entry.changes[0].field] : undefined;
      return phrase ? `${phrase} ${item}` : `updated ${item}`;
    }
    case "WORK_ITEM_TYPE_CHANGED":
      return `changed the type of ${item}`;
    case "WORK_ITEM_PARENT_CHANGED":
      if (entry.subjectName && entry.previousSubjectName) return `moved ${item} from ${entry.previousSubjectName} to ${entry.subjectName}`;
      if (entry.subjectName) return `moved ${item} under ${entry.subjectName}`;
      return entry.previousSubjectName ? `removed ${item} from ${entry.previousSubjectName}` : `changed the parent of ${item}`;
    case "WORK_ITEM_ASSIGNED":
      // A null subject means "unassigned" (assignees are never deleted).
      return entry.subjectName ? `assigned ${item} to ${entry.subjectName}` : `unassigned ${item}`;
    case "WORK_ITEM_PRIORITY_CHANGED":
      return `changed the priority of ${item}`;
    case "WORK_ITEM_STATUS_CHANGED":
      return `changed the status of ${item}`;
    case "WORK_ITEM_ARCHIVED":
      return `archived ${item}`;
    case "WORK_ITEM_RESTORED":
      return `restored ${item}`;
    case "WORK_ITEM_REORDERED":
      // subject = next item, previous = preceding item (backlog-visible neighbours at move time).
      if (entry.subjectName && !entry.previousSubjectName) return `moved ${item} to the top of the backlog, above ${entry.subjectName}`;
      if (entry.previousSubjectName && !entry.subjectName) return `moved ${item} to the bottom of the backlog, below ${entry.previousSubjectName}`;
      if (entry.previousSubjectName && entry.subjectName) return `moved ${item} between ${entry.previousSubjectName} and ${entry.subjectName} in the backlog`;
      return `reordered ${item} in the backlog`;
    case "WORK_ITEM_ADDED_TO_SPRINT":
      return `added ${item} to ${entry.subjectName ?? "a sprint"}`;
    case "WORK_ITEM_REMOVED_FROM_SPRINT":
      return `returned ${item} from ${entry.subjectName ?? "a sprint"} to the backlog`;
    case "WORK_ITEM_MOVED_BETWEEN_SPRINTS":
      return `moved ${item} from ${entry.previousSubjectName ?? "a sprint"} to ${entry.subjectName ?? "a sprint"}`;
    case "WORK_ITEM_STARTED":
      return `started work on ${item}`;
    case "WORK_ITEM_SUBMITTED_FOR_REVIEW":
      return `submitted ${item} for review`;
    case "WORK_ITEM_REVIEW_APPROVED":
      return `approved ${item}`;
    case "WORK_ITEM_REVIEW_REJECTED":
      return `requested changes on ${item}`;
    case "WORK_ITEM_BLOCKED":
      return `marked ${item} as blocked`;
    case "WORK_ITEM_RESUMED":
      return `resumed work on ${item}`;
    // Comment text is never part of the audit; the discussion shows it.
    case "WORK_ITEM_COMMENT_ADDED":
      return `commented on ${item}`;
    case "WORK_ITEM_COMMENT_EDITED":
      return `edited a comment on ${item}`;
    case "WORK_ITEM_COMMENT_DELETED":
      return `deleted a comment on ${item}`;
    case "SPRINT_CREATED":
      return `created ${sprintName(entry)}`;
    case "SPRINT_UPDATED":
      return `updated ${sprintName(entry)}`;
    case "SPRINT_CAPACITY_CHANGED":
      return `changed the capacity of ${sprintName(entry)}`;
    case "SPRINT_STARTED":
      return `started ${sprintName(entry)}`;
    case "SPRINT_COMPLETED": {
      const carried = Number(entry.changes.find((change) => change.field === "carried_over")?.to ?? 0);
      if (!carried) return `completed ${sprintName(entry)}`;
      return `completed ${sprintName(entry)} and carried ${carried} unfinished item${carried === 1 ? "" : "s"} to ${entry.previousSubjectName ?? "the backlog"}`;
    }
    case "SPRINT_CANCELLED":
      return `cancelled ${sprintName(entry)}`;
  }
}

function sprintName(entry: { sprint?: ActivityEntry["sprint"] }): string {
  return entry.sprint?.name ?? "a sprint";
}

export type ActivityDetail = { label: string; from: string | null; to: string };

/** Field-level details shown under an entry. Description text is never available. */
export function activityDetails(entry: Pick<ActivityEntry, "action" | "changes">): ActivityDetail[] {
  if (entry.action === "PROJECT_CREATED" || entry.action === "WORK_ITEM_CREATED" || entry.action === "SPRINT_CREATED") {
    // The name/title is already part of the sentence.
    return entry.changes
      .filter((change) => change.field !== "name" && change.field !== "title")
      .map((change) => ({
        label: FIELD_LABELS[change.field],
        from: null,
        to: change.field === "description" || change.field === "goal" ? "Added" : displayValue(change.field, change.to),
      }));
  }
  if (entry.action === "SPRINT_COMPLETED" || entry.action === "SPRINT_CANCELLED") {
    return entry.changes.map((change) => ({ label: FIELD_LABELS[change.field], from: null, to: change.to ?? "0" }));
  }
  if (entry.action === "PROJECT_UPDATED" || entry.action.startsWith("WORK_ITEM_") || entry.action === "SPRINT_UPDATED" || entry.action === "SPRINT_CAPACITY_CHANGED") {
    return entry.changes.map((change) =>
      change.field === "reason"
        ? { label: FIELD_LABELS.reason, from: null, to: change.to ?? "Not recorded" }
        : change.field === "description" || change.field === "goal"
        ? { label: FIELD_LABELS[change.field], from: null, to: "Updated" }
        : { label: FIELD_LABELS[change.field], from: displayValue(change.field, change.from), to: displayValue(change.field, change.to) },
    );
  }
  return [];
}

export type ActivityTone = "primary" | "accent" | "success" | "warning" | "neutral" | "danger";

export const ACTIVITY_TONES: Record<ActivityAction, ActivityTone> = {
  PROJECT_CREATED: "primary",
  PROJECT_UPDATED: "neutral",
  PROJECT_MANAGER_CHANGED: "accent",
  PROJECT_ARCHIVED: "warning",
  PROJECT_RESTORED: "success",
  PROJECT_MEMBER_ADDED: "success",
  PROJECT_MEMBER_REMOVED: "danger",
  WORK_ITEM_CREATED: "primary",
  WORK_ITEM_UPDATED: "neutral",
  WORK_ITEM_TYPE_CHANGED: "neutral",
  WORK_ITEM_PARENT_CHANGED: "neutral",
  WORK_ITEM_ASSIGNED: "accent",
  WORK_ITEM_PRIORITY_CHANGED: "warning",
  WORK_ITEM_STATUS_CHANGED: "success",
  WORK_ITEM_ARCHIVED: "warning",
  WORK_ITEM_RESTORED: "success",
  WORK_ITEM_REORDERED: "neutral",
  WORK_ITEM_ADDED_TO_SPRINT: "primary",
  WORK_ITEM_REMOVED_FROM_SPRINT: "neutral",
  WORK_ITEM_MOVED_BETWEEN_SPRINTS: "accent",
  WORK_ITEM_STARTED: "accent",
  WORK_ITEM_SUBMITTED_FOR_REVIEW: "primary",
  WORK_ITEM_REVIEW_APPROVED: "success",
  WORK_ITEM_REVIEW_REJECTED: "warning",
  WORK_ITEM_BLOCKED: "danger",
  WORK_ITEM_RESUMED: "accent",
  WORK_ITEM_COMMENT_ADDED: "primary",
  WORK_ITEM_COMMENT_EDITED: "neutral",
  WORK_ITEM_COMMENT_DELETED: "neutral",
  SPRINT_CREATED: "primary",
  SPRINT_UPDATED: "neutral",
  SPRINT_CAPACITY_CHANGED: "neutral",
  SPRINT_STARTED: "accent",
  SPRINT_COMPLETED: "success",
  SPRINT_CANCELLED: "danger",
};

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function dayKey(date: Date, timeZone?: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export type ActivityGroup = { key: string; label: string; entries: ActivityEntry[] };

/**
 * Groups entries (already newest first) by calendar day in the given time zone.
 * Labels are "Today", "Yesterday", or a full date.
 */
export function groupActivityByDay(entries: readonly ActivityEntry[], now: Date, timeZone?: string): ActivityGroup[] {
  const today = dayKey(now, timeZone);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000), timeZone);
  const full = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const groups: ActivityGroup[] = [];
  for (const entry of entries) {
    const date = new Date(entry.createdAt);
    const key = dayKey(date, timeZone);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: key === today ? "Today" : key === yesterday ? "Yesterday" : full.format(date), entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

export function formatActivityTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

export function formatActivityDateTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago"; null beyond a week. */
export function relativeTime(iso: string, now: Date): string | null {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds) || seconds < 0) return null;
  if (seconds < 60) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (seconds < 3600) return rtf.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86_400) return rtf.format(-Math.floor(seconds / 3600), "hour");
  if (seconds < 7 * 86_400) return rtf.format(-Math.floor(seconds / 86_400), "day");
  return null;
}

export function isActivityCursor(value: unknown): value is ActivityCursor {
  if (typeof value !== "object" || value === null) return false;
  const cursor = value as Record<string, unknown>;
  return typeof cursor.createdAt === "string" && !Number.isNaN(new Date(cursor.createdAt).getTime()) && isUuid(cursor.id);
}
