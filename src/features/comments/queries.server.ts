import "server-only";

import { requireActiveProfile } from "@/features/auth/server";
import { loadAvatars } from "@/features/profile/avatars.server";
import { ProjectError } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { createClient } from "@/lib/supabase/server";

import {
  COMMENT_PAGE_SIZE, MENTION_RESULTS, REPLY_PAGE_SIZE, REPLY_PREVIEW,
  toComment, toCommentPage, toMentionCandidate, toReplyPage,
  type Comment, type CommentCursor, type CommentPage, type MentionCandidate, type ReplyPage,
} from "./logic";

/*
 * Server-only discussion reads (Phase 8G2). One bounded RPC per call plus one
 * batched avatar read; the database decides visibility (SA, assigned PM,
 * member developer) and hides items the caller cannot see.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

function authorIds(rows: readonly unknown[]): string[] {
  return rows.flatMap((row) => {
    const id = (row as { author_id?: unknown } | null)?.author_id;
    return isUuid(id) ? [id] : [];
  });
}

/** Parses comment rows with one avatar lookup for all authors (no per-row queries). */
export async function toComments(rows: readonly unknown[]): Promise<Comment[]> {
  // Decorative: on any failure loadAvatars returns an empty map.
  const avatars = await loadAvatars(authorIds(rows));
  return rows.map((row) => toComment(row, avatars));
}

async function client(): Promise<Client> {
  await requireActiveProfile();
  return createClient();
}

export async function listComments(workItemId: string, cursor: CommentCursor | null = null): Promise<CommentPage> {
  if (!isUuid(workItemId)) throw new ProjectError("not_found");
  const supabase = await client();
  const { data, error } = await supabase.rpc("list_work_item_comments", {
    p_work_item_id: workItemId,
    p_after_created_at: cursor?.createdAt,
    p_after_id: cursor?.id,
    // One extra thread tells us whether another page exists.
    p_limit: COMMENT_PAGE_SIZE + 1,
    p_reply_limit: REPLY_PREVIEW,
  });
  if (error) failProject("list_work_item_comments", error);
  return toCommentPage(await toComments(data ?? []));
}

export async function listReplies(parentId: string, cursor: CommentCursor): Promise<ReplyPage> {
  if (!isUuid(parentId)) throw new ProjectError("comment_not_found");
  const supabase = await client();
  const { data, error } = await supabase.rpc("list_comment_replies", {
    p_parent_comment_id: parentId, p_after_created_at: cursor.createdAt, p_after_id: cursor.id, p_limit: REPLY_PAGE_SIZE + 1,
  });
  if (error) failProject("list_comment_replies", error);
  return toReplyPage(await toComments(data ?? []));
}

/** Eligible people for the @ autocomplete (bounded; never the whole directory). */
export async function searchMentionCandidates(workItemId: string, search: string): Promise<MentionCandidate[]> {
  if (!isUuid(workItemId)) throw new ProjectError("not_found");
  const supabase = await client();
  const { data, error } = await supabase.rpc("search_comment_mentions", {
    p_work_item_id: workItemId, p_search: search.slice(0, 60) || undefined, p_limit: MENTION_RESULTS,
  });
  if (error) failProject("search_comment_mentions", error);
  const rows: unknown[] = data ?? [];
  const ids = rows.flatMap((row) => {
    const id = (row as { id?: unknown } | null)?.id;
    return isUuid(id) ? [id] : [];
  });
  const avatars = await loadAvatars(ids);
  return rows.map((row) => toMentionCandidate(row, avatars));
}
