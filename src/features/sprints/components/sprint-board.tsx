"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Loader2, OctagonAlert, Search, UserRound, X } from "lucide-react";

import { ProjectPriorityBadge } from "@/features/projects/components/project-badges";
import { control } from "@/features/projects/components/styles";
import { PRIORITY_LABELS, PROJECT_PRIORITIES, type ProjectPriority } from "@/features/projects/types";
import { MoveDialog, type PendingMove } from "@/features/work-items/components/move-dialog";
import { IssueKey, WorkTypeIcon } from "@/features/work-items/components/work-badges";
import { moveWorkItemAction } from "@/features/work-items/execution-actions";
import {
  availableMoves,
  EMPTY_BOARD_FILTERS,
  filterBoard,
  groupBoard,
  moveForColumn,
  optimisticPatch,
  patchBoardItem,
  summarizeBoard,
  type SprintProgress,
  type BoardColumn,
  type BoardFilters,
  type BoardItem,
  type Move,
  type MoveViewer,
} from "@/features/work-items/execution";
import { TYPE_LABELS, WORK_ITEM_TYPES, WORK_STATUS_LABELS, type WorkItemType } from "@/features/work-items/types";
import { cn } from "@/lib/utils/cn";

import { formatPoints } from "../logic";
import { ProgressSummary } from "./sprint-progress";

const COLUMN_LABELS: Record<BoardColumn, string> = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  IN_REVIEW: "In review",
  BLOCKED: "Blocked",
  DONE: "Done",
};

const COLUMN_ACCENTS: Record<BoardColumn, string> = {
  TODO: "bg-text-muted",
  IN_PROGRESS: "bg-primary",
  IN_REVIEW: "bg-accent",
  BLOCKED: "bg-danger",
  DONE: "bg-success",
};

type Notice = { tone: "success" | "error"; text: string } | null;

/**
 * Active sprint board. Moves are optimistic: the card moves at once, the server
 * (execute_work_item / change_work_item_status) confirms or the card snaps back.
 * Only the moved card is patched; a conflict refreshes the board from the server.
 */
export function SprintBoard({ projectId, sprintId, items: serverItems, progress, viewer }: {
  projectId: string;
  sprintId: string;
  items: BoardItem[];
  progress: SprintProgress | null;
  viewer: MoveViewer;
}) {
  const router = useRouter();
  const [items, setItems] = useState(serverItems);
  const [source, setSource] = useState(serverItems);
  // New server data (after router.refresh) replaces the local copy.
  if (source !== serverItems) {
    setSource(serverItems);
    setItems(serverItems);
  }
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_BOARD_FILTERS);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<Notice>(null);
  const [dialog, setDialog] = useState<(PendingMove & { item: BoardItem }) | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<BoardColumn | null>(null);

  const people = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of serverItems) if (item.assigneeId) seen.set(item.assigneeId, item.assigneeName ?? "Former member");
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [serverItems]);
  const visible = useMemo(() => filterBoard(items, filters, viewer.id), [items, filters, viewer.id]);
  const columns = useMemo(() => groupBoard(visible), [visible]);
  const filtered = visible.length !== items.length;
  const dragged = dragId ? items.find((item) => item.id === dragId) ?? null : null;
  // Live summary from the cards (same rules as the database); the server total when the board is capped.
  const summary = progress && (serverItems.length < 500 ? { ...progress, total: summarizeBoard(items, progress.total.cancelledItems) } : progress);

  async function perform(item: BoardItem, move: Move, reason: string | null) {
    const before = item; // the card as the viewer saw it
    setBusy((current) => new Set(current).add(item.id));
    setNotice(null);
    setItems((current) => patchBoardItem(current, item.id, optimisticPatch(before, move, reason)));
    let result;
    try {
      result = await moveWorkItemAction({ projectId, sprintId, workItemId: item.id, from: before.status, to: move.to, action: move.action, reason, refresh: false });
    } catch {
      result = { ok: false as const, error: "The change could not be saved. Check your connection and try again.", code: "unavailable" as const, conflict: false };
    }
    if (result.ok) {
      const { status, blockedFromStatus, blockedReason, updatedAt } = result.item;
      setItems((current) => patchBoardItem(current, item.id, { status, blockedFromStatus, blockedReason, ...(updatedAt ? { updatedAt } : {}) }));
      setNotice({ tone: "success", text: `${item.issueKey}: ${result.message}` });
    } else {
      // Roll back this card only.
      setItems((current) => patchBoardItem(current, item.id, { status: before.status, blockedFromStatus: before.blockedFromStatus, blockedReason: before.blockedReason }));
      setNotice({ tone: "error", text: `${item.issueKey}: ${result.error}` });
      if (result.conflict || result.code === "not_found" || result.code === "forbidden") router.refresh();
    }
    setBusy((current) => {
      const next = new Set(current);
      next.delete(item.id);
      return next;
    });
  }

  function request(item: BoardItem, move: Move) {
    if (busy.has(item.id)) return;
    if (move.needsReason || move.confirm) setDialog({ move, item, itemKey: item.issueKey, itemTitle: item.title });
    else void perform(item, move, null);
  }

  function drop(column: BoardColumn) {
    setOverColumn(null);
    const item = dragged;
    setDragId(null);
    if (!item) return;
    const move = moveForColumn(item, column, viewer);
    if (move) request(item, move);
    else if (column !== (item.status === "BACKLOG" ? "TODO" : item.status)) setNotice({ tone: "error", text: `${item.issueKey} can’t move to ${COLUMN_LABELS[column]} from ${WORK_STATUS_LABELS[item.status]}.` });
  }

  const set = (patch: Partial<BoardFilters>) => setFilters((current) => ({ ...current, ...patch }));

  return (
    <div className="space-y-4">
      {summary && (
        <section aria-label="Sprint progress" className="rounded-xl border border-border bg-surface p-5 shadow-sm lg:max-w-xl">
          <ProgressSummary progress={summary} />
        </section>
      )}
      <div role="search" aria-label="Filter the board" className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted" />
          <label htmlFor="board-search" className="sr-only">Search by key or title</label>
          <input id="board-search" type="search" value={filters.search} onChange={(event) => set({ search: event.target.value })} placeholder="Search key or title" className={cn(control, "h-9 pl-9")} />
        </div>
        <label htmlFor="board-assignee" className="sr-only">Assignee</label>
        <select id="board-assignee" value={filters.assignee} onChange={(event) => set({ assignee: event.target.value })} className={cn(control, "h-9 w-auto")}>
          <option value="any">Everyone</option>
          <option value="mine">Only my items</option>
          <option value="unassigned">Unassigned</option>
          {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <label htmlFor="board-type" className="sr-only">Type</label>
        <select id="board-type" value={filters.type ?? ""} onChange={(event) => set({ type: (event.target.value || null) as WorkItemType | null })} className={cn(control, "h-9 w-auto")}>
          <option value="">All types</option>
          {WORK_ITEM_TYPES.filter((type) => type !== "EPIC").map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
        </select>
        <label htmlFor="board-priority" className="sr-only">Priority</label>
        <select id="board-priority" value={filters.priority ?? ""} onChange={(event) => set({ priority: (event.target.value || null) as ProjectPriority | null })} className={cn(control, "h-9 w-auto")}>
          <option value="">All priorities</option>
          {PROJECT_PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>)}
        </select>
        {filtered && (
          <button type="button" onClick={() => setFilters(EMPTY_BOARD_FILTERS)} className="inline-flex h-9 items-center gap-1 rounded-md px-2 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary">
            <X aria-hidden="true" className="size-4" />Clear
          </button>
        )}
        <p className="ml-auto text-xs text-text-muted tabular-nums" aria-live="polite">
          {filtered ? `${visible.length} of ${items.length} items` : `${items.length} item${items.length === 1 ? "" : "s"}`}
        </p>
      </div>

      <div aria-live="polite" aria-atomic="true" className="min-h-5 text-sm">
        {notice && <p role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? "text-danger" : "text-success"}>{notice.text}</p>}
      </div>

      {/* Columns scroll horizontally on small screens; five columns fit from xl. */}
      <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        <div className="grid min-w-[70rem] grid-cols-5 gap-3 xl:min-w-0">
          {columns.map((group) => {
            const target = dragged ? moveForColumn(dragged, group.column, viewer) : null;
            const home = dragged && (dragged.status === "BACKLOG" ? "TODO" : dragged.status) === group.column;
            return (
              <section
                key={group.column}
                aria-labelledby={`col-${group.column}`}
                onDragOver={(event) => {
                  if (!target) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (overColumn !== group.column) setOverColumn(group.column);
                }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverColumn(null); }}
                onDrop={(event) => { event.preventDefault(); drop(group.column); }}
                className={cn(
                  "flex min-h-64 flex-col rounded-xl border bg-surface-muted/60 transition-colors",
                  overColumn === group.column && target ? "border-primary bg-primary/5" : "border-border",
                  dragged && !target && !home && "opacity-60",
                )}
              >
                <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                  <h2 id={`col-${group.column}`} className="flex items-center gap-2 text-xs font-semibold tracking-wide text-text-secondary uppercase">
                    <span aria-hidden="true" className={cn("size-2 rounded-full", COLUMN_ACCENTS[group.column])} />
                    {COLUMN_LABELS[group.column]}
                  </h2>
                  <p className="text-xs text-text-muted tabular-nums">
                    <span className="font-semibold text-text-primary">{group.count}</span>
                    <span className="sr-only"> items,</span> · {formatPoints(group.points)} pts
                    {group.unestimated > 0 && <span title={`${group.unestimated} not estimated`}> · {group.unestimated}?</span>}
                  </p>
                </header>
                <ol className="flex flex-1 flex-col gap-2 p-2">
                  {group.items.map((item) => (
                    <BoardCard key={item.id} projectId={projectId} item={item} viewer={viewer} busy={busy.has(item.id)}
                      onMove={(move) => request(item, move)}
                      onDragStart={() => setDragId(item.id)} onDragEnd={() => { setDragId(null); setOverColumn(null); }} />
                  ))}
                  {group.items.length === 0 && (
                    <li className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-text-muted">
                      {filtered ? "No matching items" : "Nothing here"}
                    </li>
                  )}
                </ol>
              </section>
            );
          })}
        </div>
      </div>

      <MoveDialog
        pending={dialog}
        onCancel={() => setDialog(null)}
        onSubmit={(reason) => {
          const current = dialog;
          setDialog(null);
          if (current) void perform(current.item, current.move, reason);
        }}
      />
    </div>
  );
}

function BoardCard({ projectId, item, viewer, busy, onMove, onDragStart, onDragEnd }: {
  projectId: string;
  item: BoardItem;
  viewer: MoveViewer;
  busy: boolean;
  onMove: (move: Move) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const moves = availableMoves(item, viewer);
  const primary = moves.find((move) => move.action && move.action !== "block" && move.action !== "reject") ?? null;
  const others = moves.filter((move) => move !== primary);
  const draggable = moves.length > 0 && !busy;
  const mine = item.assigneeId !== null && item.assigneeId === viewer.id;

  return (
    <li
      draggable={draggable}
      onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.issueKey); onDragStart(); }}
      onDragEnd={onDragEnd}
      aria-busy={busy}
      className={cn(
        "group rounded-lg border border-border bg-surface p-3 shadow-sm",
        draggable && "cursor-grab active:cursor-grabbing",
        busy && "opacity-70",
        item.status === "BLOCKED" && "border-danger/40",
      )}
    >
      <div className="flex items-start gap-2">
        <WorkTypeIcon type={item.type} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <IssueKey issueKey={item.issueKey} />
            {item.status === "BACKLOG" && <span className="rounded bg-surface-muted px-1.5 text-[0.65rem] font-semibold text-text-secondary uppercase">Not ready</span>}
            {busy && <Loader2 aria-label="Saving" className="size-3.5 animate-spin text-text-muted" />}
          </div>
          <Link href={`/projects/${projectId}/work/${item.id}`} draggable={false} className="mt-0.5 line-clamp-3 text-sm font-medium break-words hover:text-primary">
            {item.title}
          </Link>
        </div>
      </div>

      {item.status === "BLOCKED" && (
        <p className="mt-2 flex gap-1.5 rounded-md bg-danger/5 px-2 py-1.5 text-xs text-danger">
          <OctagonAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            {item.blockedReason ?? "Blocked"}
            {item.blockedFromStatus && <span className="text-text-muted"> · was {WORK_STATUS_LABELS[item.blockedFromStatus]}</span>}
          </span>
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
        <ProjectPriorityBadge priority={item.priority} />
        <span className={cn("inline-flex min-w-0 items-center gap-1", item.assigneeId ? "text-text-secondary" : "text-text-muted")}>
          <UserRound aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{item.assigneeName ?? "Unassigned"}{mine && " (you)"}</span>
        </span>
        <span className="ml-auto rounded-md bg-surface-muted px-1.5 py-0.5 font-semibold text-text-secondary tabular-nums" title="Estimate (story points)">
          {item.estimate === null ? "–" : formatPoints(item.estimate)}<span className="sr-only"> points</span>
        </span>
      </div>

      {moves.length > 0 && (
        <div className="mt-2.5 flex items-center gap-1.5 border-t border-border pt-2.5">
          {primary && (
            <button type="button" disabled={busy} onClick={() => onMove(primary)}
              className={cn("inline-flex h-7 min-w-0 items-center rounded-md px-2 text-xs font-medium disabled:opacity-60",
                primary.tone === "success" ? "bg-success/10 text-success hover:bg-success/20" : "bg-primary/10 text-primary hover:bg-primary/20")}>
              <span className="truncate">{primary.label}</span>
            </button>
          )}
          {others.length > 0 && (
            <details className="relative ml-auto">
              <summary className={cn("flex h-7 cursor-pointer list-none items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-surface-muted [&::-webkit-details-marker]:hidden", busy && "pointer-events-none opacity-60")}>
                {primary ? "More" : "Move"}<ChevronDown aria-hidden="true" className="size-3.5" />
                <span className="sr-only"> actions for {item.issueKey}</span>
              </summary>
              <ul className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-border bg-surface p-1 shadow-lg">
                {others.map((move) => (
                  <li key={`${move.action ?? "status"}-${move.to}`}>
                    <button type="button" disabled={busy}
                      onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onMove(move); }}
                      className={cn("w-full rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-surface-muted", move.tone === "danger" && "text-danger", move.tone === "success" && "text-success")}>
                      {move.label}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </li>
  );
}
