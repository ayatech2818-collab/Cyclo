import type { ResolvedAvatar } from "@/features/profile/avatar";

// Relative imports keep this module loadable by the plain-Node unit tests.
import { bodySegments, type CommentMention } from "../comments/logic";
import { fallbackActorAvatar } from "../projects/activity";
import { ProjectError } from "../projects/errors";
import { isUuid } from "../projects/validation";

/*
 * Notifications (Phase 8G3): pure logic shared by the server code, the client
 * components and the unit tests. Notifications are created by the database
 * (audit-log trigger); this module only parses, words and links them.
 */

export const NOTIFICATION_EVENTS = [
  "MENTIONED", "COMMENT_REPLY", "COMMENT_ADDED", "REPLY_ADDED",
  "WORK_ITEM_ASSIGNED", "REVIEW_REQUESTED", "REVIEW_APPROVED", "REVIEW_CHANGES_REQUESTED",
  "WORK_ITEM_BLOCKED", "WORK_ITEM_RESUMED", "PROJECT_MEMBER_ADDED", "PROJECT_MANAGER_ASSIGNED",
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_CATEGORIES = ["assignment", "comment", "mention", "review_requested", "review_decision", "blocked", "project"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<NotificationCategory, { label: string; description: string }> = {
  assignment: { label: "Assignments", description: "A work item is assigned to you." },
  comment: { label: "Comments and replies", description: "Comments on work you are assigned to or manage, and replies to your comments." },
  mention: { label: "@Mentions", description: "Someone mentions you in a comment." },
  review_requested: { label: "Review requests", description: "Work in a project you manage is submitted for review." },
  review_decision: { label: "Review decisions", description: "Your work is approved or changes are requested." },
  blocked: { label: "Blocked and resumed work", description: "Work you manage or are assigned to is blocked or resumed." },
  project: { label: "Project membership", description: "You are added to a project team or made its Project Manager." },
};

export const NOTIFICATION_PAGE_SIZE = 20;
export const DROPDOWN_SIZE = 8;

export type NotificationStatus = "all" | "unread" | "read";

export type Notification = {
  id: string;
  event: NotificationEvent;
  category: NotificationCategory;
  createdAt: string;
  readAt: string | null;
  actorId: string | null;
  actorName: string | null;
  actorAvatar: ResolvedAvatar;
  /** False once the recipient can no longer access the project: no names are returned then. */
  accessible: boolean;
  project: { id: string; name: string; key: string } | null;
  workItem: { id: string; issueKey: string; title: string } | null;
  comment: { id: string; excerpt: string | null } | null;
  reason: string | null;
};

export type NotificationCursor = { createdAt: string; id: string };
export type NotificationPage = { notifications: Notification[]; nextCursor: NotificationCursor | null };

// ---------------------------------------------------------------------------
// Rows (fail closed)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProjectError("unexpected");
  return value as Row;
}
function text(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ProjectError("unexpected");
  return value;
}
function id(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (!isUuid(value)) throw new ProjectError("unexpected");
  return value.toLowerCase();
}
function time(row: Row, key: string): string | null {
  const value = text(row, key);
  if (value !== null && Number.isNaN(Date.parse(value))) throw new ProjectError("unexpected");
  return value;
}

export function isNotificationEvent(value: unknown): value is NotificationEvent {
  return typeof value === "string" && (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}
export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === "string" && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

/** Plain-text excerpt of a stored comment body (mention tokens become "@Name"). */
export function commentExcerpt(body: string | null, mentions: readonly CommentMention[], max = 140): string | null {
  if (!body) return null;
  const plain = bodySegments(body, mentions).map((segment) => (segment.type === "text" ? segment.text : `@${segment.name ?? "someone"}`)).join("");
  const flat = plain.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Parses one notification row; `avatars` holds server-resolved photos (SA/PM viewers). */
export function toNotification(value: unknown, avatars: ReadonlyMap<string, ResolvedAvatar> = new Map()): Notification {
  const row = asRow(value);
  const notificationId = id(row, "id");
  const createdAt = time(row, "created_at");
  if (!notificationId || !createdAt || !isNotificationEvent(row.event_type) || !isNotificationCategory(row.category) || typeof row.accessible !== "boolean") {
    throw new ProjectError("unexpected");
  }
  const actorId = id(row, "actor_id");
  const projectId = id(row, "project_id");
  const projectName = text(row, "project_name");
  const projectKey = text(row, "project_key");
  const workItemId = id(row, "work_item_id");
  const issueKey = text(row, "issue_key");
  const title = text(row, "work_item_title");
  const commentId = id(row, "comment_id");
  const mentions = Array.isArray(row.comment_mentions)
    ? row.comment_mentions.map((entry) => {
      const mention = asRow(entry);
      return { id: id(mention, "id") ?? "", name: text(mention, "name") };
    })
    : [];
  return {
    id: notificationId,
    event: row.event_type,
    category: row.category,
    createdAt,
    readAt: time(row, "read_at"),
    actorId,
    actorName: text(row, "actor_name")?.trim() || null,
    actorAvatar: (actorId && avatars.get(actorId)) || fallbackActorAvatar(row.actor_avatar_kind, row.actor_avatar_symbol),
    accessible: row.accessible,
    project: row.accessible && projectId && projectName && projectKey ? { id: projectId, name: projectName, key: projectKey } : null,
    workItem: row.accessible && workItemId && issueKey && title ? { id: workItemId, issueKey, title } : null,
    comment: row.accessible && commentId ? { id: commentId, excerpt: commentExcerpt(text(row, "comment_body"), mentions) } : null,
    reason: row.accessible ? text(row, "reason") : null,
  };
}

export function toNotificationPage(notifications: readonly Notification[], pageSize = NOTIFICATION_PAGE_SIZE): NotificationPage {
  const page = notifications.slice(0, pageSize);
  const last = page[page.length - 1];
  return { notifications: page, nextCursor: notifications.length > pageSize && last ? { createdAt: last.createdAt, id: last.id } : null };
}

export function isNotificationCursor(value: unknown): value is NotificationCursor {
  if (typeof value !== "object" || value === null) return false;
  const { createdAt, id: cursorId } = value as Record<string, unknown>;
  return typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt)) && isUuid(cursorId);
}

// ---------------------------------------------------------------------------
// Wording and links
// ---------------------------------------------------------------------------

/** The sentence after the actor's name, e.g. "mentioned you in CPR-12". */
export function describeNotification(notification: Pick<Notification, "event" | "workItem" | "project" | "accessible">): string {
  if (!notification.accessible) return "sent you a notification about a project you no longer have access to";
  const item = notification.workItem?.issueKey ?? "a work item";
  const project = notification.project?.name ?? "a project";
  switch (notification.event) {
    case "MENTIONED": return `mentioned you in ${item}`;
    case "COMMENT_REPLY": return `replied to your comment on ${item}`;
    case "COMMENT_ADDED": return `commented on ${item}`;
    case "REPLY_ADDED": return `replied in a discussion on ${item}`;
    case "WORK_ITEM_ASSIGNED": return `assigned ${item} to you`;
    case "REVIEW_REQUESTED": return `submitted ${item} for review`;
    case "REVIEW_APPROVED": return `approved ${item}`;
    case "REVIEW_CHANGES_REQUESTED": return `requested changes on ${item}`;
    case "WORK_ITEM_BLOCKED": return `marked ${item} as blocked`;
    case "WORK_ITEM_RESUMED": return `resumed work on ${item}`;
    case "PROJECT_MEMBER_ADDED": return `added you to ${project}`;
    case "PROJECT_MANAGER_ASSIGNED": return `made you the Project Manager of ${project}`;
  }
}

export function actorLabel(notification: Pick<Notification, "actorName">): string {
  return notification.actorName ?? "A former employee";
}

/** Secondary line: comment excerpt, reason, or item title. */
export function notificationDetail(notification: Notification): string | null {
  if (!notification.accessible) return null;
  if (notification.comment) return notification.comment.excerpt ?? "This comment was deleted.";
  if (notification.reason) return `“${notification.reason}”`;
  return notification.workItem?.title ?? null;
}

/** Where a notification leads: the comment, the work item, or the project. */
export function notificationHref(notification: Pick<Notification, "project" | "workItem" | "comment">): string | null {
  if (!notification.project) return null;
  if (!notification.workItem) return `/projects/${notification.project.id}`;
  const base = `/projects/${notification.project.id}/work/${notification.workItem.id}`;
  return notification.comment ? `${base}#comment-${notification.comment.id}` : base;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** Merges fresh rows into a newest-first list without duplicates. */
export function mergeNotifications(current: readonly Notification[], incoming: readonly Notification[]): Notification[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
}

export function markRead(list: readonly Notification[], ids: ReadonlySet<string> | "all", at: string): Notification[] {
  return list.map((entry) => (!entry.readAt && (ids === "all" || ids.has(entry.id)) ? { ...entry, readAt: at } : entry));
}

export function matchesFilter(notification: Notification, status: NotificationStatus, category: NotificationCategory | null): boolean {
  if (status === "unread" && notification.readAt) return false;
  if (status === "read" && !notification.readAt) return false;
  return category === null || notification.category === category;
}

export function badgeLabel(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

export type NotificationQuery = { status: NotificationStatus; category: NotificationCategory | null };

export function parseNotificationQuery(params: Record<string, string | string[] | undefined>): NotificationQuery {
  const status = typeof params.status === "string" ? params.status : "";
  const category = typeof params.type === "string" ? params.type : "";
  return {
    status: status === "unread" || status === "read" ? status : "all",
    category: isNotificationCategory(category) ? category : null,
  };
}

export function notificationsHref(query: NotificationQuery, overrides: Partial<NotificationQuery> = {}): string {
  const next = { ...query, ...overrides };
  const params = new URLSearchParams();
  if (next.status !== "all") params.set("status", next.status);
  if (next.category) params.set("type", next.category);
  const search = params.toString();
  return `/notifications${search ? `?${search}` : ""}`;
}

export type NotificationGroup = { key: string; label: string; notifications: Notification[] };

/** Newest-first notifications grouped by calendar day ("Today", "Yesterday", or a date). */
export function groupByDay(notifications: readonly Notification[], now: Date, timeZone?: string): NotificationGroup[] {
  const key = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const today = key(now);
  const yesterday = key(new Date(now.getTime() - 86_400_000));
  const full = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const groups: NotificationGroup[] = [];
  for (const notification of notifications) {
    const date = new Date(notification.createdAt);
    const day = key(date);
    let group = groups[groups.length - 1];
    if (!group || group.key !== day) {
      group = { key: day, label: day === today ? "Today" : day === yesterday ? "Yesterday" : full.format(date), notifications: [] };
      groups.push(group);
    }
    group.notifications.push(notification);
  }
  return groups;
}
