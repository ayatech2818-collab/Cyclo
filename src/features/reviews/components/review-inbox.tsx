"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Clock, FolderKanban, Hourglass, Inbox, Loader2, RotateCcw, UserRound } from "lucide-react";

import { ProjectPriorityBadge } from "@/features/projects/components/project-badges";
import { MoveDialog, type PendingMove } from "@/features/work-items/components/move-dialog";
import { IssueKey, WorkStatusBadge, WorkTypeIcon } from "@/features/work-items/components/work-badges";
import { REVIEW_MOVES } from "@/features/work-items/execution";
import { cn } from "@/lib/utils/cn";

import { decideReviewAction, type ReviewDecision } from "../actions";
import { formatSubmittedAt, formatWaiting, removeFromSummary, waitingTone, type ReviewItem, type ReviewSummary, type WaitingTone } from "../logic";

type Notice = { tone: "success" | "error"; text: string } | null;

const TONE_STYLES: Record<WaitingTone, string> = {
  fresh: "bg-surface-muted text-text-secondary",
  aging: "bg-accent/10 text-accent",
  overdue: "bg-danger/10 text-danger",
};

/** Stat value colour (the mobile stats hide their icon, so the value carries the tone). */
const TONE_TEXT: Record<WaitingTone, string> = { fresh: "", aging: "text-accent", overdue: "text-danger" };

/**
 * The review queue. A decision removes the row and decrements the counts at
 * once; the server action then revalidates /reviews, so the page refills with
 * the next items and the authoritative counts. One request per item at a time
 * (duplicate clicks are ignored); the database rejects stale decisions.
 */
export function ReviewInbox({ items: serverItems, summary: serverSummary, now, filtered, page }: {
  items: ReviewItem[];
  summary: ReviewSummary;
  /** Server render time (ms), so waiting times match between server and client. */
  now: number;
  filtered: boolean;
  page: number;
}) {
  const router = useRouter();
  // Items and counts change together; new server data (after revalidation) replaces both.
  const [state, setState] = useState({ items: serverItems, summary: serverSummary });
  const [source, setSource] = useState({ serverItems, serverSummary });
  if (source.serverItems !== serverItems || source.serverSummary !== serverSummary) {
    setSource({ serverItems, serverSummary });
    setState({ items: serverItems, summary: serverSummary });
  }
  const { items, summary } = state;
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const [notice, setNotice] = useState<Notice>(null);
  const [dialog, setDialog] = useState<(PendingMove & { item: ReviewItem; decision: ReviewDecision }) | null>(null);

  const setItemBusy = (id: string, on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // Idempotent: if fresh server data already dropped the row, its counts are already right.
  const remove = (item: ReviewItem) =>
    setState((current) => current.items.some((entry) => entry.id === item.id)
      ? { items: current.items.filter((entry) => entry.id !== item.id), summary: removeFromSummary(current.summary, item) }
      : current);

  async function decide(item: ReviewItem, decision: ReviewDecision, reason: string | null) {
    if (inFlight.current.has(item.id)) return; // a second click while the first is running
    inFlight.current.add(item.id);
    setItemBusy(item.id, true);
    setNotice(null);
    let result;
    try {
      result = await decideReviewAction({ workItemId: item.id, decision, reason });
    } catch {
      result = { ok: false as const, error: "The decision could not be saved. Check your connection and try again.", code: "unavailable" as const, handled: false };
    }
    if (result.ok) {
      remove(item);
      setNotice({ tone: "success", text: `${item.issueKey}: ${result.message}` });
    } else {
      if (result.handled) {
        remove(item);
        router.refresh();
      }
      setNotice({ tone: "error", text: `${item.issueKey}: ${result.error}` });
    }
    inFlight.current.delete(item.id);
    setItemBusy(item.id, false);
  }

  const request = (item: ReviewItem, decision: ReviewDecision) => {
    if (inFlight.current.has(item.id)) return;
    setDialog({ move: REVIEW_MOVES[decision], item, decision, itemKey: item.issueKey, itemTitle: item.title });
  };

  const oldest = summary.oldestSubmittedAt;

  return (
    <div className="space-y-6">
      <section aria-label="Review summary" className="grid grid-cols-3 gap-2 sm:gap-3">
        <Stat icon={Inbox} label="Pending reviews" value={String(summary.total)} live />
        <Stat icon={Hourglass} label="Oldest waiting" value={oldest ? formatWaiting(oldest, now) : "–"}
          tone={oldest ? waitingTone(oldest, now) : "fresh"} />
        <Stat icon={FolderKanban} label="Projects with reviews" value={String(summary.projects.length)} />
      </section>

      {summary.projects.length > 1 && (
        <nav aria-label="Pending reviews by project" className="flex flex-wrap gap-2">
          {summary.projects.map((project) => (
            <Link key={project.id} href={`/reviews?project=${project.id}`}
              className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium hover:border-primary/40 hover:bg-primary/5">
              <span className="font-mono text-text-secondary">{project.projectKey}</span>
              <span className="truncate">{project.label}</span>
              <span className="rounded-full bg-accent/10 px-1.5 font-semibold text-accent tabular-nums">{project.count}</span>
            </Link>
          ))}
        </nav>
      )}

      <div aria-live="polite" aria-atomic="true" className="min-h-5 text-sm">
        {notice && <p role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? "text-danger" : "text-success"}>{notice.text}</p>}
      </div>

      {items.length > 0 ? (
        <ol aria-label="Review queue" className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
          {items.map((item) => (
            <ReviewRow key={item.id} item={item} now={now} busy={busy.has(item.id)} onDecide={(decision) => request(item, decision)} />
          ))}
        </ol>
      ) : (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-surface px-6 py-14 text-center">
          <span className="mb-4 rounded-full bg-success/10 p-3 text-success"><Check aria-hidden="true" className="size-6" /></span>
          <h2 className="text-base font-semibold">{filtered ? "No matching reviews" : summary.total > 0 && page > 1 ? "This page is done" : "All caught up"}</h2>
          <p className="mt-1 max-w-sm text-sm text-text-secondary">
            {filtered ? "Nothing awaiting review matches these filters." : summary.total > 0 ? "More reviews are waiting on other pages." : "No work is waiting for your review. New submissions appear here."}
          </p>
        </div>
      )}

      <MoveDialog
        pending={dialog}
        onCancel={() => setDialog(null)}
        onSubmit={(reason) => {
          const current = dialog;
          setDialog(null);
          if (current) void decide(current.item, current.decision, reason);
        }}
      />
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone = "fresh", live = false }: { icon: typeof Inbox; label: string; value: string; tone?: WaitingTone; live?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface p-3 shadow-sm sm:p-4">
      <span className={cn("hidden size-9 shrink-0 items-center justify-center rounded-lg sm:flex", tone === "fresh" ? "bg-primary/10 text-primary" : TONE_STYLES[tone])}>
        <Icon aria-hidden="true" className="size-4.5" />
      </span>
      <div className="min-w-0">
        <p className="text-xs leading-tight font-medium text-text-secondary">{label}</p>
        <p className={cn("text-lg font-semibold tabular-nums sm:text-xl", TONE_TEXT[tone])}
          aria-live={live ? "polite" : undefined}>{value}</p>
      </div>
    </div>
  );
}

function ReviewRow({ item, now, busy, onDecide }: { item: ReviewItem; now: number; busy: boolean; onDecide: (decision: ReviewDecision) => void }) {
  const tone = waitingTone(item.submittedAt, now);
  const assignee = item.assigneeId ? item.assigneeName ?? "Unnamed developer" : "Unassigned";
  return (
    <li aria-busy={busy} className={cn("flex flex-col gap-3 p-4 sm:px-5 md:flex-row md:items-center md:gap-5", busy && "opacity-70")}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <WorkTypeIcon type={item.type} className="mt-0.5" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <IssueKey issueKey={item.issueKey} />
            <WorkStatusBadge status="IN_REVIEW" />
            {busy && <Loader2 aria-label="Saving" className="size-3.5 animate-spin text-text-muted" />}
          </div>
          <Link href={`/projects/${item.projectId}/work/${item.id}`} className="block text-sm font-medium break-words hover:text-primary">
            {item.title}
          </Link>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-text-secondary">
            <Link href={`/projects/${item.projectId}`} className="inline-flex min-w-0 items-center gap-1 hover:text-text-primary">
              <FolderKanban aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{item.projectName}</span>
            </Link>
            <span className={cn("inline-flex min-w-0 items-center gap-1", !item.assigneeId && "text-text-muted")}>
              <UserRound aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate"><span className="sr-only">Assignee: </span>{assignee}</span>
            </span>
            <ProjectPriorityBadge priority={item.priority} />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 md:flex-col md:items-end md:border-0 md:pt-0">
        <div className="text-left md:text-right">
          <p className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums", TONE_STYLES[tone])}>
            <Clock aria-hidden="true" className="size-3.5" />
            <span className="sr-only">Waiting </span>{formatWaiting(item.submittedAt, now)}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Submitted <time dateTime={item.submittedAt}>{formatSubmittedAt(item.submittedAt)}</time>
          </p>
        </div>
        <div role="group" aria-label={`Review actions for ${item.issueKey}`} className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => onDecide("reject")}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-xs font-medium hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60">
            <RotateCcw aria-hidden="true" className="size-3.5" />Request changes
          </button>
          <button type="button" disabled={busy} onClick={() => onDecide("approve")}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-success/40 bg-success/10 px-2.5 text-xs font-semibold text-success hover:bg-success/20 disabled:cursor-not-allowed disabled:opacity-60">
            <Check aria-hidden="true" className="size-3.5" />Approve
          </button>
        </div>
      </div>
    </li>
  );
}
