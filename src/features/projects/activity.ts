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
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export const ACTIVITY_FIELDS = [
  "name", "project_key", "title", "type", "status", "priority", "start_date", "target_date", "due_date", "estimate", "description",
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
  };
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
};

function displayValue(field: ActivityField, value: string | null): string {
  if (value === null || value === "") return "Not set";
  if (field === "status" && isProjectStatus(value)) return STATUS_LABELS[value];
  if (field === "status" && isWorkItemStatus(value)) return WORK_STATUS_LABELS[value];
  if (field === "type" && isWorkItemType(value)) return TYPE_LABELS[value];
  if (field === "priority" && isProjectPriority(value)) return PRIORITY_LABELS[value];
  if (field === "start_date" || field === "target_date" || field === "due_date") return formatProjectDate(value) ?? value;
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
export function describeActivity(entry: Pick<ActivityEntry, "action" | "subjectName" | "previousSubjectName" | "changes" | "workItem">): string {
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
  }
}

export type ActivityDetail = { label: string; from: string | null; to: string };

/** Field-level details shown under an entry. Description text is never available. */
export function activityDetails(entry: Pick<ActivityEntry, "action" | "changes">): ActivityDetail[] {
  if (entry.action === "PROJECT_CREATED" || entry.action === "WORK_ITEM_CREATED") {
    // The name/title is already part of the sentence.
    return entry.changes
      .filter((change) => change.field !== "name" && change.field !== "title")
      .map((change) => ({
        label: FIELD_LABELS[change.field],
        from: null,
        to: change.field === "description" ? "Added" : displayValue(change.field, change.to),
      }));
  }
  if (entry.action === "PROJECT_UPDATED" || entry.action.startsWith("WORK_ITEM_")) {
    return entry.changes.map((change) =>
      change.field === "description"
        ? { label: FIELD_LABELS.description, from: null, to: "Updated" }
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
