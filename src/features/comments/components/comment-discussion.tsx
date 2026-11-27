"use client";

import { useState, useTransition } from "react";
import { CornerDownRight, Loader2, MessageSquare, MessageSquareX, Pencil, Reply, Trash2 } from "lucide-react";

import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import type { ResolvedAvatar } from "@/features/profile/avatar";
import { formatActivityDateTime, relativeTime } from "@/features/projects/activity";
import { useViewerClock } from "@/features/projects/components/project-activity";
import { cn } from "@/lib/utils/cn";

import { createCommentAction, deleteCommentAction, loadMoreCommentsAction, loadMoreRepliesAction, updateCommentAction } from "../actions";
import { bodySegments, mentionedIds, toEditorText, type Comment, type CommentCursor, type CommentMention, type CommentPage, type CommentThread } from "../logic";
import { CommentComposer } from "./comment-composer";

export type DiscussionViewer = { id: string; name: string | null; avatar: ResolvedAvatar };

type Notice = { tone: "error" | "success"; text: string } | null;

let tempCounter = 0;
const tempId = () => `temp-${Date.now()}-${++tempCounter}`;
const isTemp = (id: string) => id.startsWith("temp-");

function optimisticComment(viewer: DiscussionViewer, workItemId: string, parentId: string | null, body: string, picked: CommentMention[]): Comment {
  const ids = new Set(mentionedIds(body));
  return {
    id: tempId(), workItemId, parentId, authorId: viewer.id, authorName: viewer.name, authorAvatar: viewer.avatar,
    body, createdAt: new Date().toISOString(), editedAt: null, deletedAt: null, replyCount: 0,
    mentions: picked.filter((person) => ids.has(person.id)),
  };
}

/**
 * Work item discussion: comments oldest first, one level of replies, @mentions.
 * Every change shows at once and rolls back if the server refuses it.
 */
export function CommentDiscussion({ workItemId, initialPage, viewer, canWrite }: {
  workItemId: string;
  initialPage: CommentPage;
  viewer: DiscussionViewer;
  /** False for archived projects/items: read-only. */
  canWrite: boolean;
}) {
  const [threads, setThreads] = useState<CommentThread[]>(initialPage.threads);
  const [cursor, setCursor] = useState<CommentCursor | null>(initialPage.nextCursor);
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, startLoading] = useTransition();
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const { now, timeZone } = useViewerClock();

  const total = threads.reduce((sum, thread) => sum + (thread.comment.deletedAt ? 0 : 1) + thread.replies.length, 0);

  // --- state helpers -------------------------------------------------------
  const replaceComment = (id: string, next: Comment) =>
    setThreads((current) => current.map((thread) => thread.comment.id === id
      ? { ...thread, comment: { ...next, replyCount: next.parentId === null ? Math.max(next.replyCount, thread.replies.length) : 0 } }
      : { ...thread, replies: thread.replies.map((reply) => (reply.id === id ? next : reply)) }));

  // --- create ------------------------------------------------------------------
  async function create(parentId: string | null, body: string, picked: CommentMention[]): Promise<boolean> {
    const draft = optimisticComment(viewer, workItemId, parentId, body, picked);
    setNotice(null);
    setThreads((current) => parentId === null
      ? [...current, { comment: draft, replies: [], repliesCursor: null }]
      : current.map((thread) => (thread.comment.id === parentId
        ? { ...thread, replies: [...thread.replies, draft], comment: { ...thread.comment, replyCount: thread.comment.replyCount + 1 } }
        : thread)));
    let result;
    try {
      result = await createCommentAction({ workItemId, body, parentId });
    } catch {
      result = { ok: false as const, error: "The comment could not be saved. Check your connection and try again.", code: "unavailable" as const };
    }
    if (result.ok) {
      replaceComment(draft.id, result.comment);
      if (parentId) setReplyingTo(null);
      return true;
    }
    // Roll back.
    setThreads((current) => parentId === null
      ? current.filter((thread) => thread.comment.id !== draft.id)
      : current.map((thread) => (thread.comment.id === parentId
        ? { ...thread, replies: thread.replies.filter((reply) => reply.id !== draft.id), comment: { ...thread.comment, replyCount: Math.max(0, thread.comment.replyCount - 1) } }
        : thread)));
    setNotice({ tone: "error", text: result.error });
    return false;
  }

  // --- edit --------------------------------------------------------------------
  async function edit(comment: Comment, body: string, picked: CommentMention[]): Promise<boolean> {
    const ids = new Set(mentionedIds(body));
    setNotice(null);
    replaceComment(comment.id, { ...comment, body, editedAt: comment.body === body ? comment.editedAt : new Date().toISOString(), mentions: picked.filter((person) => ids.has(person.id)) });
    let result;
    try {
      result = await updateCommentAction({ commentId: comment.id, body });
    } catch {
      result = { ok: false as const, error: "The change could not be saved. Check your connection and try again.", code: "unavailable" as const };
    }
    if (result.ok) {
      replaceComment(comment.id, result.comment);
      return true;
    }
    replaceComment(comment.id, comment);
    setNotice({ tone: "error", text: result.error });
    return false;
  }

  // --- delete --------------------------------------------------------------------
  async function remove(comment: Comment) {
    const snapshot = threads;
    setNotice(null);
    setThreads((current) => current.flatMap((thread) => {
      if (thread.comment.id === comment.id) {
        // A thread with replies keeps a placeholder; otherwise it disappears.
        return thread.replies.length > 0 ? [{ ...thread, comment: { ...thread.comment, body: null, deletedAt: new Date().toISOString(), mentions: [] } }] : [];
      }
      const replies = thread.replies.filter((reply) => reply.id !== comment.id);
      if (replies.length === thread.replies.length) return [thread];
      const next = { ...thread, replies, comment: { ...thread.comment, replyCount: Math.max(0, thread.comment.replyCount - 1) } };
      // A deleted parent whose last reply goes away disappears too.
      return next.comment.deletedAt && replies.length === 0 && next.comment.replyCount === 0 ? [] : [next];
    }));
    let result;
    try {
      result = await deleteCommentAction(comment.id);
    } catch {
      result = { ok: false as const, error: "The comment could not be deleted. Check your connection and try again.", code: "unavailable" as const };
    }
    if (result.ok) {
      setNotice({ tone: "success", text: "Comment deleted." });
      return;
    }
    // Roll back this comment's thread from the snapshot, keeping other changes.
    const original = snapshot.find((thread) => thread.comment.id === comment.id || thread.replies.some((reply) => reply.id === comment.id));
    if (original) {
      setThreads((current) => {
        const index = current.findIndex((thread) => thread.comment.id === original.comment.id);
        if (index >= 0) return current.map((thread, i) => (i === index ? original : thread));
        const position = snapshot.indexOf(original);
        return [...current.slice(0, position), original, ...current.slice(position)];
      });
    }
    setNotice({ tone: "error", text: result.error });
  }

  // --- paging ----------------------------------------------------------------------
  const loadMore = () => {
    if (!cursor) return;
    startLoading(async () => {
      let result;
      try {
        result = await loadMoreCommentsAction(workItemId, cursor);
      } catch {
        result = { ok: false as const, error: "More comments could not be loaded. Try again." };
      }
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      const seen = new Set(threads.map((thread) => thread.comment.id));
      setThreads((current) => [...current, ...result.page.threads.filter((thread) => !seen.has(thread.comment.id))]);
      setCursor(result.page.nextCursor);
    });
  };

  const loadReplies = (thread: CommentThread) => {
    if (!thread.repliesCursor) return;
    startLoading(async () => {
      let result;
      try {
        result = await loadMoreRepliesAction(thread.comment.id, thread.repliesCursor);
      } catch {
        result = { ok: false as const, error: "Replies could not be loaded. Try again." };
      }
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      setThreads((current) => current.map((entry) => {
        if (entry.comment.id !== thread.comment.id) return entry;
        const seen = new Set(entry.replies.map((reply) => reply.id));
        return { ...entry, replies: [...entry.replies, ...result.page.replies.filter((reply) => !seen.has(reply.id))], repliesCursor: result.page.nextCursor };
      }));
    });
  };

  const shared = { viewer, now, timeZone, canWrite, workItemId, onEdit: edit, onDelete: remove };

  return (
    <div className="space-y-5">
      <div aria-live="polite" className="min-h-0 text-sm empty:hidden">
        {notice && <p role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? "text-danger" : "text-success"}>{notice.text}</p>}
      </div>

      {threads.length === 0 ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed border-border px-6 py-8 text-center">
          <span className="mb-3 rounded-full bg-primary/10 p-2.5 text-primary"><MessageSquare aria-hidden="true" className="size-5" /></span>
          <p className="text-sm font-medium">No comments yet</p>
          <p className="mt-1 max-w-xs text-xs text-text-secondary">
            {canWrite ? "Start the discussion: ask a question, share progress or @mention a teammate." : "This work item is read-only."}
          </p>
        </div>
      ) : (
        <ol aria-label={`${total} comment${total === 1 ? "" : "s"}`} className="space-y-5">
          {threads.map((thread) => (
            <li key={thread.comment.id}>
              <CommentItem comment={thread.comment} {...shared}
                onReply={canWrite && !thread.comment.deletedAt ? () => setReplyingTo(thread.comment.id) : undefined} />
              {(thread.replies.length > 0 || replyingTo === thread.comment.id) && (
                <div className="mt-3 ml-4 space-y-3 border-l-2 border-border pl-4 sm:ml-5 sm:pl-5">
                  {thread.replies.length > 0 && (
                    <ol aria-label="Replies" className="space-y-3">
                      {thread.replies.map((reply) => (
                        <li key={reply.id}>
                          <CommentItem comment={reply} {...shared} compact
                            onReply={canWrite && !thread.comment.deletedAt ? () => setReplyingTo(thread.comment.id) : undefined} />
                        </li>
                      ))}
                    </ol>
                  )}
                  {thread.repliesCursor && (
                    <button type="button" disabled={loading} onClick={() => loadReplies(thread)}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline disabled:opacity-60">
                      <CornerDownRight aria-hidden="true" className="size-3.5" />
                      Show {thread.comment.replyCount - thread.replies.length} more {thread.comment.replyCount - thread.replies.length === 1 ? "reply" : "replies"}
                    </button>
                  )}
                  {replyingTo === thread.comment.id && (
                    <CommentComposer workItemId={workItemId} compact autoFocus submitLabel="Reply" placeholder="Write a reply…"
                      onSubmit={(body, picked) => create(thread.comment.id, body, picked)} onCancel={() => setReplyingTo(null)} />
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {cursor && (
        <button type="button" onClick={loadMore} disabled={loading}
          className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface text-sm font-medium hover:bg-surface-muted disabled:opacity-60">
          {loading && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
          Load more comments
        </button>
      )}

      {canWrite ? (
        <div className="flex gap-3 border-t border-border pt-5">
          <div className="hidden sm:block"><EmployeeAvatar fullName={viewer.name} email={null} avatarUrl={null} avatar={viewer.avatar} size="sm" /></div>
          <div className="min-w-0 flex-1">
            <CommentComposer workItemId={workItemId} submitLabel="Comment" placeholder="Add a comment…" onSubmit={(body, picked) => create(null, body, picked)} />
          </div>
        </div>
      ) : (
        <p className="border-t border-border pt-4 text-xs text-text-muted">Comments are read-only for archived work.</p>
      )}
    </div>
  );
}

function CommentItem({ comment, viewer, now, timeZone, canWrite, workItemId, compact = false, onReply, onEdit, onDelete }: {
  comment: Comment;
  viewer: DiscussionViewer;
  now: Date | null;
  timeZone: string | undefined;
  canWrite: boolean;
  workItemId: string;
  compact?: boolean;
  onReply?: () => void;
  onEdit: (comment: Comment, body: string, picked: CommentMention[]) => Promise<boolean>;
  onDelete: (comment: Comment) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  // After a failed save the editor reopens with the text the user wrote, not the old text.
  const [retry, setRetry] = useState<{ initialText: string; initialPicked: CommentMention[] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const pending = isTemp(comment.id);
  const own = comment.authorId === viewer.id;
  const name = comment.authorName ?? "A former employee";
  const relative = now ? relativeTime(comment.createdAt, now) : null;

  if (comment.deletedAt) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-surface-muted/60 px-3 py-2 text-xs text-text-muted italic">
        <MessageSquareX aria-hidden="true" className="size-3.5 not-italic" />
        This comment was deleted.
      </div>
    );
  }

  return (
    <article aria-label={`Comment by ${name}`} aria-busy={pending} className={cn("group flex gap-3", pending && "opacity-70")}>
      <EmployeeAvatar fullName={comment.authorName} email={null} avatarUrl={null} avatar={comment.authorAvatar} size="sm" />
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold">{name}</span>
          {own && <span className="rounded bg-primary/10 px-1.5 text-[0.65rem] font-semibold text-primary uppercase">You</span>}
          <time dateTime={comment.createdAt} title={formatActivityDateTime(comment.createdAt, timeZone)} className="text-xs text-text-muted">
            {pending ? "Sending…" : relative ?? `${formatActivityDateTime(comment.createdAt, timeZone)}${timeZone === "UTC" ? " UTC" : ""}`}
          </time>
          {comment.editedAt && !pending && (
            <span className="text-xs text-text-muted" title={`Edited ${formatActivityDateTime(comment.editedAt, timeZone)}`}>· edited</span>
          )}
        </header>

        {editing ? (
          <div className="mt-1.5">
            <CommentComposer workItemId={workItemId} autoFocus compact={compact} submitLabel="Save"
              placeholder="Edit your comment…"
              {...(retry ?? toEditorInitial(comment))}
              onSubmit={async (body, picked) => {
                setEditing(false);
                setRetry(null);
                const ok = await onEdit(comment, body, picked);
                if (!ok) {
                  const draft = toEditorText(body, picked);
                  setRetry({ initialText: draft.text, initialPicked: draft.picked });
                  setEditing(true);
                }
                return ok;
              }}
              onCancel={() => { setEditing(false); setRetry(null); }} />
          </div>
        ) : (
          <p className="mt-0.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-text-primary">
            {bodySegments(comment.body ?? "", comment.mentions).map((segment, index) =>
              segment.type === "text" ? (
                <span key={index}>{segment.text}</span>
              ) : (
                <span key={index} className={cn("rounded px-1 font-medium", segment.id === viewer.id ? "bg-accent/15 text-accent" : "bg-primary/10 text-primary")}>
                  @{segment.name ?? "unknown"}
                </span>
              ),
            )}
          </p>
        )}

        {!editing && !pending && (canWrite || confirming) && (
          confirming ? (
            <div role="alertdialog" aria-label="Delete comment" className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs">
              <span className="mr-auto">Delete this comment? This can’t be undone.</span>
              <button type="button" autoFocus onClick={() => setConfirming(false)} className="rounded px-2 py-1 font-medium text-text-secondary hover:bg-surface-muted">Cancel</button>
              <button type="button" onClick={() => { setConfirming(false); void onDelete(comment); }}
                className="rounded bg-danger px-2 py-1 font-medium text-danger-foreground hover:bg-danger-hover">Delete</button>
            </div>
          ) : (
            <div className="mt-1 flex items-center gap-1 text-xs">
              {onReply && <ActionButton icon={Reply} label="Reply" onClick={onReply} />}
              {own && <ActionButton icon={Pencil} label="Edit" onClick={() => setEditing(true)} />}
              {own && <ActionButton icon={Trash2} label="Delete" onClick={() => setConfirming(true)} danger />}
            </div>
          )
        )}
      </div>
    </article>
  );
}

function toEditorInitial(comment: Comment): { initialText: string; initialPicked: CommentMention[] } {
  const { text, picked } = toEditorText(comment.body ?? "", comment.mentions);
  return { initialText: text, initialPicked: picked };
}

function ActionButton({ icon: Icon, label, onClick, danger = false }: { icon: typeof Reply; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-text-muted hover:bg-surface-muted", danger ? "hover:text-danger" : "hover:text-text-primary")}>
      <Icon aria-hidden="true" className="size-3.5" />{label}
    </button>
  );
}
