"use server";

import { ProjectError, type ProjectErrorCode } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { requireActiveProfile } from "@/features/auth/server";
import { createClient } from "@/lib/supabase/server";

import { isCommentCursor, validateStoredBody, type Comment, type CommentPage, type MentionCandidate, type ReplyPage } from "./logic";
import { listComments, listReplies, searchMentionCandidates, toComments } from "./queries.server";

/*
 * Discussion Server Actions (Phase 8G2). The client sends only ids and text:
 * the author is the session user, and the project, permissions and mention
 * eligibility are decided by the database.
 */

export type CommentResult = { ok: true; comment: Comment } | { ok: false; error: string; code: ProjectErrorCode };
export type LoadResult<T> = { ok: true; page: T } | { ok: false; error: string };

const CLIENT_MESSAGES = {
  empty: "Write a comment first.",
  too_long: "Comments can be up to 5,000 characters.",
  too_many_mentions: "Mention at most 20 people in one comment.",
} as const;

function failure(error: unknown): { ok: false; error: string; code: ProjectErrorCode } {
  if (!(error instanceof ProjectError)) throw error;
  return { ok: false, error: error.message, code: error.code };
}

function checkBody(body: unknown): string | { ok: false; error: string; code: ProjectErrorCode } {
  if (typeof body !== "string") return failure(new ProjectError("invalid_comment"));
  const problem = validateStoredBody(body);
  return problem ? { ok: false, error: CLIENT_MESSAGES[problem], code: problem === "too_many_mentions" ? "too_many_mentions" : "invalid_comment" } : body;
}

async function single(operation: string, call: () => PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>): Promise<Comment> {
  let response;
  try {
    response = await call();
  } catch {
    throw new ProjectError("unavailable");
  }
  if (response.error) failProject(operation, response.error);
  const rows = (response.data ?? []) as unknown[];
  if (rows.length !== 1) throw new ProjectError("unexpected");
  return (await toComments(rows))[0];
}

export async function createCommentAction(input: { workItemId: string; body: string; parentId: string | null }): Promise<CommentResult> {
  if (!isUuid(input.workItemId) || (input.parentId !== null && !isUuid(input.parentId))) return failure(new ProjectError("not_found"));
  const body = checkBody(input.body);
  if (typeof body !== "string") return body;
  await requireActiveProfile();
  const supabase = await createClient();
  try {
    const comment = await single("create_work_item_comment", () =>
      supabase.rpc("create_work_item_comment", { p_work_item_id: input.workItemId, p_body: body, p_parent_comment_id: input.parentId ?? undefined }));
    return { ok: true, comment };
  } catch (error) {
    return failure(error);
  }
}

export async function updateCommentAction(input: { commentId: string; body: string }): Promise<CommentResult> {
  if (!isUuid(input.commentId)) return failure(new ProjectError("comment_not_found"));
  const body = checkBody(input.body);
  if (typeof body !== "string") return body;
  await requireActiveProfile();
  const supabase = await createClient();
  try {
    const comment = await single("update_work_item_comment", () => supabase.rpc("update_work_item_comment", { p_comment_id: input.commentId, p_body: body }));
    return { ok: true, comment };
  } catch (error) {
    return failure(error);
  }
}

export async function deleteCommentAction(commentId: string): Promise<CommentResult> {
  if (!isUuid(commentId)) return failure(new ProjectError("comment_not_found"));
  await requireActiveProfile();
  const supabase = await createClient();
  try {
    const comment = await single("delete_work_item_comment", () => supabase.rpc("delete_work_item_comment", { p_comment_id: commentId }));
    return { ok: true, comment };
  } catch (error) {
    return failure(error);
  }
}

/** "Load more comments". The cursor is untrusted input, validated here and in the database. */
export async function loadMoreCommentsAction(workItemId: string, cursor: unknown): Promise<LoadResult<CommentPage>> {
  if (!isCommentCursor(cursor)) return { ok: false, error: "The discussion could not be continued. Reload the page." };
  try {
    return { ok: true, page: await listComments(workItemId, cursor) };
  } catch (error) {
    return failure(error);
  }
}

export async function loadMoreRepliesAction(parentId: string, cursor: unknown): Promise<LoadResult<ReplyPage>> {
  if (!isCommentCursor(cursor)) return { ok: false, error: "The replies could not be loaded. Reload the page." };
  try {
    return { ok: true, page: await listReplies(parentId, cursor) };
  } catch (error) {
    return failure(error);
  }
}

export async function searchMentionsAction(workItemId: string, search: unknown): Promise<LoadResult<MentionCandidate[]>> {
  if (typeof search !== "string") return { ok: false, error: "Search could not run." };
  try {
    return { ok: true, page: await searchMentionCandidates(workItemId, search.replace(/[\u0000-\u001f\u007f]/g, " ").trim()) };
  } catch (error) {
    return failure(error);
  }
}
