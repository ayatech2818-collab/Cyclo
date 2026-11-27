import type { ResolvedAvatar } from "@/features/profile/avatar";

// Relative imports keep this module loadable by the plain-Node unit tests.
import { fallbackActorAvatar } from "../projects/activity";
import { ProjectError } from "../projects/errors";
import { isUuid } from "../projects/validation";

/*
 * Work item discussion (Phase 8G2): pure logic shared by the server code, the
 * client components and the unit tests. The database validates every body,
 * mention and permission again; nothing here is trusted by it.
 *
 * Stored body: plain text where a mention is the token <@profile-uuid>.
 * Editor text: the same text with "@Full Name" in place of each token, plus
 * the list of people picked from the autocomplete. Converting back only turns
 * "@Name" into a token for people actually picked, so typing an "@" by hand
 * never creates a mention.
 */

export const COMMENT_MAX = 5000;
export const COMMENT_PAGE_SIZE = 20;
/** Replies shown with each thread before "Show more replies". */
export const REPLY_PREVIEW = 20;
export const REPLY_PAGE_SIZE = 50;
export const MENTION_MAX = 20;
export const MENTION_RESULTS = 8;

const TOKEN = /<@([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>/g;

export type CommentMention = { id: string; name: string | null };

export type Comment = {
  id: string;
  workItemId: string;
  parentId: string | null;
  authorId: string;
  authorName: string | null;
  authorAvatar: ResolvedAvatar;
  /** Null once deleted. */
  body: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  replyCount: number;
  mentions: CommentMention[];
};

export type CommentCursor = { createdAt: string; id: string };
export type CommentThread = { comment: Comment; replies: Comment[]; repliesCursor: CommentCursor | null };
export type CommentPage = { threads: CommentThread[]; nextCursor: CommentCursor | null };
export type ReplyPage = { replies: Comment[]; nextCursor: CommentCursor | null };

export type MentionCandidate = {
  id: string;
  name: string;
  role: "SUPER_ADMIN" | "PROJECT_MANAGER" | "DEVELOPER";
  isProjectManager: boolean;
  avatar: ResolvedAvatar;
};

// ---------------------------------------------------------------------------
// Rows (fail closed)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProjectError("unexpected");
  return value as Row;
}
function uuid(row: Row, key: string): string {
  const value = row[key];
  if (!isUuid(value)) throw new ProjectError("unexpected");
  return value.toLowerCase();
}
function nullableUuid(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (!isUuid(value)) throw new ProjectError("unexpected");
  return value.toLowerCase();
}
function timestamp(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new ProjectError("unexpected");
  return value;
}
function nullableTimestamp(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return timestamp(row, key);
}
function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ProjectError("unexpected");
  return value;
}

function parseMentions(value: unknown): CommentMention[] {
  if (!Array.isArray(value)) throw new ProjectError("unexpected");
  return value.map((item) => {
    const row = asRow(item);
    return { id: uuid(row, "id"), name: nullableText(row, "name")?.trim() || null };
  });
}

/** Parses one comment row; `avatars` holds server-resolved photos (SA/PM viewers). */
export function toComment(value: unknown, avatars: ReadonlyMap<string, ResolvedAvatar> = new Map()): Comment {
  const row = asRow(value);
  const authorId = uuid(row, "author_id");
  const deletedAt = nullableTimestamp(row, "deleted_at");
  const body = nullableText(row, "body");
  if ((deletedAt === null) !== (body !== null)) throw new ProjectError("unexpected");
  const replyCount = row.reply_count;
  if (typeof replyCount !== "number" || !Number.isInteger(replyCount) || replyCount < 0) throw new ProjectError("unexpected");
  return {
    id: uuid(row, "id"),
    workItemId: uuid(row, "work_item_id"),
    parentId: nullableUuid(row, "parent_comment_id"),
    authorId,
    authorName: nullableText(row, "author_name")?.trim() || null,
    authorAvatar: avatars.get(authorId) ?? fallbackActorAvatar(row.author_avatar_kind, row.author_avatar_symbol),
    body,
    createdAt: timestamp(row, "created_at"),
    editedAt: nullableTimestamp(row, "edited_at"),
    deletedAt,
    replyCount,
    mentions: parseMentions(row.mentions ?? []),
  };
}

const cursorOf = (comment: Pick<Comment, "createdAt" | "id">): CommentCursor => ({ createdAt: comment.createdAt, id: comment.id });

/**
 * Groups list_work_item_comments rows (thread, its replies, next thread, ...)
 * into threads. The database returns one thread more than `pageSize` when
 * another page exists; that thread is dropped and becomes the cursor's limit.
 */
export function toCommentPage(comments: readonly Comment[], pageSize = COMMENT_PAGE_SIZE, replyPreview = REPLY_PREVIEW): CommentPage {
  const threads: CommentThread[] = [];
  const byId = new Map<string, CommentThread>();
  for (const comment of comments) {
    if (comment.parentId === null) {
      const thread: CommentThread = { comment, replies: [], repliesCursor: null };
      threads.push(thread);
      byId.set(comment.id, thread);
    } else {
      const thread = byId.get(comment.parentId);
      if (!thread) throw new ProjectError("unexpected");
      thread.replies.push(comment);
    }
  }
  for (const thread of threads) {
    const last = thread.replies[thread.replies.length - 1];
    thread.repliesCursor = last && thread.comment.replyCount > thread.replies.length && thread.replies.length >= replyPreview ? cursorOf(last) : null;
  }
  const hasMore = threads.length > pageSize;
  const page = threads.slice(0, pageSize);
  return { threads: page, nextCursor: hasMore ? cursorOf(page[page.length - 1].comment) : null };
}

export function toReplyPage(replies: readonly Comment[], pageSize = REPLY_PAGE_SIZE): ReplyPage {
  const hasMore = replies.length > pageSize;
  const page = replies.slice(0, pageSize);
  return { replies: page, nextCursor: hasMore ? cursorOf(page[page.length - 1]) : null };
}

export function toMentionCandidate(value: unknown, avatars: ReadonlyMap<string, ResolvedAvatar> = new Map()): MentionCandidate {
  const row = asRow(value);
  const id = uuid(row, "id");
  const name = nullableText(row, "full_name")?.trim();
  const role = row.role;
  if (!name || (role !== "SUPER_ADMIN" && role !== "PROJECT_MANAGER" && role !== "DEVELOPER") || typeof row.is_project_manager !== "boolean") {
    throw new ProjectError("unexpected");
  }
  return { id, name, role, isProjectManager: row.is_project_manager, avatar: avatars.get(id) ?? fallbackActorAvatar(row.avatar_kind, row.avatar_symbol) };
}

export function isCommentCursor(value: unknown): value is CommentCursor {
  if (typeof value !== "object" || value === null) return false;
  const { createdAt, id } = value as Record<string, unknown>;
  return typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt)) && isUuid(id);
}

// ---------------------------------------------------------------------------
// Live updates (Realtime events are re-read, then merged here)
// ---------------------------------------------------------------------------

/** Optimistic comments not yet confirmed by the server. */
export const isPendingId = (id: string) => id.startsWith("temp-");

const byTime = (a: Pick<Comment, "createdAt" | "id">, b: Pick<Comment, "createdAt" | "id">) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);

/** Keeps pending (optimistic) entries after confirmed ones, as they were added last. */
function insertSorted<T>(list: readonly T[], entry: T, key: (item: T) => Pick<Comment, "createdAt" | "id">): T[] {
  const confirmed = list.filter((item) => !isPendingId(key(item).id));
  const pending = list.filter((item) => isPendingId(key(item).id));
  return [...confirmed, entry].sort((a, b) => byTime(key(a), key(b))).concat(pending);
}

/**
 * Applies freshly read comments to the loaded discussion. Idempotent: an
 * update for a comment already shown replaces it (never duplicates it), so the
 * author's own events are harmless. A new top-level comment is added only when
 * the end of the discussion is loaded (otherwise "Load more" brings it); a new
 * reply only when its thread's replies are fully loaded (otherwise the count
 * grows). Deleted comments disappear unless they still carry replies.
 */
export function mergeLiveComments(threads: readonly CommentThread[], incoming: readonly Comment[], endLoaded: boolean): CommentThread[] {
  let next = [...threads];
  for (const comment of [...incoming].sort(byTime)) {
    if (comment.parentId === null) {
      const index = next.findIndex((thread) => thread.comment.id === comment.id);
      if (index >= 0) {
        const thread = next[index];
        if (comment.deletedAt && thread.replies.length === 0 && comment.replyCount === 0) {
          next = next.filter((_, i) => i !== index);
        } else {
          next = next.map((entry, i) => (i === index ? { ...entry, comment: { ...comment, replyCount: Math.max(comment.replyCount, entry.replies.length) } } : entry));
        }
      } else if (!comment.deletedAt && endLoaded) {
        next = insertSorted(next, { comment, replies: [], repliesCursor: null }, (thread) => thread.comment);
      }
      continue;
    }
    const index = next.findIndex((thread) => thread.comment.id === comment.parentId);
    if (index < 0) continue; // its thread is not loaded
    const thread = next[index];
    const known = thread.replies.some((reply) => reply.id === comment.id);
    let updated: CommentThread;
    if (comment.deletedAt) {
      if (!known) continue;
      const replies = thread.replies.filter((reply) => reply.id !== comment.id);
      updated = { ...thread, replies, comment: { ...thread.comment, replyCount: Math.max(0, thread.comment.replyCount - 1) } };
      if (updated.comment.deletedAt && replies.length === 0 && updated.comment.replyCount === 0) {
        next = next.filter((_, i) => i !== index);
        continue;
      }
    } else if (known) {
      updated = { ...thread, replies: thread.replies.map((reply) => (reply.id === comment.id ? comment : reply)) };
    } else if (thread.repliesCursor) {
      updated = { ...thread, comment: { ...thread.comment, replyCount: thread.comment.replyCount + 1 } };
    } else {
      const replies = insertSorted(thread.replies, comment, (reply) => reply);
      updated = { ...thread, replies, comment: { ...thread.comment, replyCount: Math.max(thread.comment.replyCount + 1, replies.length) } };
    }
    next = next.map((entry, i) => (i === index ? updated : entry));
  }
  return next;
}

/** A confirmed comment replaces its optimistic copy; if a live event already added it, the copy just goes. */
export function confirmPending(threads: readonly CommentThread[], tempId: string, confirmed: Comment): CommentThread[] {
  const present = threads.some((thread) => thread.comment.id === confirmed.id || thread.replies.some((reply) => reply.id === confirmed.id));
  return threads.flatMap((thread) => {
    if (thread.comment.id === tempId) return present ? [] : [{ ...thread, comment: confirmed }];
    if (!thread.replies.some((reply) => reply.id === tempId)) return [thread];
    const replies = present ? thread.replies.filter((reply) => reply.id !== tempId) : thread.replies.map((reply) => (reply.id === tempId ? confirmed : reply));
    // The live event already counted this reply; drop the optimistic increment.
    const replyCount = present ? Math.max(thread.comment.replyCount - 1, replies.length) : thread.comment.replyCount;
    return [{ ...thread, replies, comment: { ...thread.comment, replyCount } }];
  });
}

/** After a reconnect: the server's view, plus anything still being sent. */
export function resyncThreads(fresh: readonly CommentThread[], current: readonly CommentThread[]): CommentThread[] {
  const pendingThreads = current.filter((thread) => isPendingId(thread.comment.id));
  return fresh.map((thread) => {
    const pendingReplies = current.find((entry) => entry.comment.id === thread.comment.id)?.replies.filter((reply) => isPendingId(reply.id)) ?? [];
    return pendingReplies.length ? { ...thread, replies: [...thread.replies, ...pendingReplies] } : thread;
  }).concat(pendingThreads);
}

// ---------------------------------------------------------------------------
// Body ⇄ editor text
// ---------------------------------------------------------------------------

export type BodySegment = { type: "text"; text: string } | { type: "mention"; id: string; name: string | null };

/** Splits a stored body into text and mention segments for rendering. */
export function bodySegments(body: string, mentions: readonly CommentMention[]): BodySegment[] {
  const names = new Map(mentions.map((mention) => [mention.id, mention.name]));
  const segments: BodySegment[] = [];
  let last = 0;
  for (const match of body.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ type: "text", text: body.slice(last, index) });
    const id = match[1].toLowerCase();
    segments.push({ type: "mention", id, name: names.get(id) ?? null });
    last = index + match[0].length;
  }
  if (last < body.length) segments.push({ type: "text", text: body.slice(last) });
  return segments;
}

/** Stored body → editor text plus the people already mentioned (for editing). */
export function toEditorText(body: string, mentions: readonly CommentMention[]): { text: string; picked: CommentMention[] } {
  const picked = new Map<string, CommentMention>();
  const text = bodySegments(body, mentions)
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      const name = segment.name ?? "unknown";
      picked.set(segment.id, { id: segment.id, name });
      return `@${name}`;
    })
    .join("");
  return { text, picked: [...picked.values()] };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Editor text → stored body. "@Name" becomes <@id> only for picked people
 * (longest names first, so "@Dev Kumar" wins over "@Dev"); a picked person
 * whose "@Name" was deleted from the text is simply not mentioned.
 */
export function toStoredBody(text: string, picked: readonly CommentMention[]): string {
  let body = text.replace(/\r\n?/g, "\n");
  const people = [...new Map(picked.filter((person) => person.name).map((person) => [person.id, person])).values()]
    .sort((a, b) => (b.name?.length ?? 0) - (a.name?.length ?? 0));
  for (const person of people) {
    const pattern = new RegExp(`(^|[^\\w@<])@${escapeRegExp(person.name!)}(?![\\p{L}\\p{N}_])`, "gu");
    body = body.replace(pattern, (_match, before: string) => `${before}<@${person.id}>`);
  }
  return body.trim();
}

/** Ids mentioned in a stored body (distinct, lower case). */
export function mentionedIds(body: string): string[] {
  return [...new Set([...body.matchAll(TOKEN)].map((match) => match[1].toLowerCase()))];
}

/** Client-side check before sending (the database is the authority). */
export function validateStoredBody(body: string): "empty" | "too_long" | "too_many_mentions" | null {
  if (!body.trim()) return "empty";
  if (body.length > COMMENT_MAX) return "too_long";
  if (mentionedIds(body).length > MENTION_MAX) return "too_many_mentions";
  return null;
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

export type MentionQuery = { start: number; query: string };

/**
 * The "@query" being typed at the caret, if any: an "@" at the start or after
 * whitespace/punctuation, followed by up to 40 characters without a newline
 * (names contain spaces, so spaces are allowed).
 */
export function mentionQueryAt(text: string, caret: number, pickedNames: readonly string[] = []): MentionQuery | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const prev = at === 0 ? "" : before[at - 1];
  if (prev && !/[\s([{"'“‘]/.test(prev)) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\n@]/.test(query) || /^\s/.test(query) || /\s{2,}$/.test(query)) return null;
  // A completed mention ("@Dev Kumar " + more text) is not a new query, although names contain spaces.
  if (pickedNames.some((name) => query === `${name} ` || query.startsWith(`${name} `))) return null;
  return { start: at, query };
}

/** Replaces the active "@query" with "@Name " and returns the new text and caret. */
export function insertMention(text: string, caret: number, mention: MentionQuery, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  const after = text.slice(caret).replace(/^\S*/, "");
  const next = text.slice(0, mention.start) + inserted + after.replace(/^ /, "");
  return { text: next, caret: mention.start + inserted.length };
}
