"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { CalendarCheck2, ChevronLeft, ChevronRight, CircleSlash, Loader2, Play, Plus, Search, Undo2 } from "lucide-react";

import type { BacklogItem } from "@/features/backlog/types";
import { ProjectPriorityBadge } from "@/features/projects/components/project-badges";
import { control, dangerButton, primaryButton, secondaryButton } from "@/features/projects/components/styles";
import { IssueKey, WorkStatusBadge, WorkTypeIcon } from "@/features/work-items/components/work-badges";
import { cn } from "@/lib/utils/cn";

import { cancelSprintAction, changeMembershipAction, completeSprintAction, moveItemsAction, searchCandidatesAction, startSprintAction, type SprintActionResult } from "../actions";
import { formatPoints } from "../logic";
import type { SprintItem } from "../types";

type SprintOption = { id: string; name: string; status: "PLANNING" | "ACTIVE" };

function Result({ result }: { result: SprintActionResult | null }) {
  if (!result?.error && !result?.success) return null;
  return <p role={result.error ? "alert" : "status"} className={cn("text-sm", result.error ? "text-danger" : "text-success")}>{result.error ?? result.success}</p>;
}

/** Runs an action, keeps its result. */
function useRun() {
  const [result, setResult] = useState<SprintActionResult | null>(null);
  const [pending, start] = useTransition();
  return { result, pending, run: (action: () => Promise<SprintActionResult>) => start(async () => setResult(await action())), clear: () => setResult(null) };
}

/** Planned work with selection for "return to backlog" and "move to sprint". */
export function SprintItemsTable({ projectId, sprintId, items, canEdit, moveTargets }: {
  projectId: string;
  sprintId: string;
  items: SprintItem[];
  canEdit: boolean;
  moveTargets: SprintOption[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState("");
  const { result, pending, run } = useRun();
  const ids = [...selected];
  const toggle = (id: string, on: boolean) => setSelected((current) => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });
  const after = (response: SprintActionResult) => { if (response.success) setSelected(new Set()); return response; };

  if (items.length === 0) {
    return <p className="px-5 py-10 text-center text-sm text-text-secondary">No work planned yet.{canEdit && " Add items from the backlog below."}</p>;
  }
  return (
    <div>
      {canEdit && selected.size > 0 && (
        <div role="region" aria-label="Selected items" className="flex flex-col gap-2 border-b border-border bg-primary/5 px-4 py-3 sm:flex-row sm:items-center">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <button type="button" disabled={pending} onClick={() => run(async () => after(await changeMembershipAction(projectId, sprintId, "remove", ids)))} className={cn(secondaryButton, "h-8 px-3 text-xs")}>
            <Undo2 aria-hidden="true" className="size-3.5" />Return to backlog
          </button>
          {moveTargets.length > 0 && (
            <div className="flex gap-2">
              <label htmlFor="move-target" className="sr-only">Move to sprint</label>
              <select id="move-target" value={target} onChange={(event) => setTarget(event.target.value)} className={cn(control, "h-8 py-0 text-xs sm:w-48")}>
                <option value="">Move to sprint…</option>
                {moveTargets.map((option) => <option key={option.id} value={option.id}>{option.name}{option.status === "ACTIVE" ? " (active)" : ""}</option>)}
              </select>
              <button type="button" disabled={pending || !target} onClick={() => run(async () => after(await moveItemsAction(projectId, sprintId, target, ids)))} className={cn(secondaryButton, "h-8 px-3 text-xs")}>Move</button>
            </div>
          )}
          {pending && <Loader2 aria-hidden="true" className="size-4 animate-spin text-primary" />}
        </div>
      )}
      <div className="px-4"><Result result={result} /></div>
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.id} className={cn("grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 px-4 py-2.5 md:grid-cols-[auto_minmax(0,1fr)_7.5rem_6.5rem_9rem_3rem]", item.archivedAt && "opacity-60")}>
            <div className="flex items-center gap-2">
              {canEdit && <input type="checkbox" aria-label={`Select ${item.issueKey}`} checked={selected.has(item.id)} onChange={(event) => toggle(item.id, event.target.checked)} className="size-4 accent-[var(--primary)]" />}
              <WorkTypeIcon type={item.type} />
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <IssueKey issueKey={item.issueKey} />
              <Link href={`/projects/${projectId}/work/${item.id}`} className="truncate text-sm font-medium hover:text-primary">{item.title}</Link>
            </div>
            <div className="col-start-2 flex flex-wrap items-center gap-2 md:contents">
              <span><WorkStatusBadge status={item.status} /></span>
              <span><ProjectPriorityBadge priority={item.priority} /></span>
              <span className="truncate text-sm text-text-secondary">{item.assigneeName ?? <span className="text-text-muted">Unassigned</span>}</span>
              <span className="text-xs text-text-secondary tabular-nums md:text-right md:text-sm">{item.estimate === null ? <span className="text-warning" title="Not estimated">–</span> : formatPoints(item.estimate)}<span className="md:hidden"> pts</span></span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Eligible work = the backlog (open, unscheduled stories, tasks and bugs). Searchable and paginated. */
export function BacklogPicker({ projectId, sprintId }: { projectId: string; sprintId: string }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<BacklogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [refresh, setRefresh] = useState(0);
  const { result, pending, run } = useRun();
  const request = useRef(0);

  useEffect(() => {
    const current = ++request.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      const response = await searchCandidatesAction(projectId, query, page);
      if (current !== request.current) return;
      setItems(response.items);
      setTotal(response.total);
      setError(response.error);
      setLoading(false);
    }, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [projectId, query, page, refresh]);

  const pageCount = Math.max(1, Math.ceil(total / 25));
  const toggle = (id: string, on: boolean) => setSelected((current) => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });
  const points = items.filter((item) => selected.has(item.id)).reduce((sum, item) => sum + (item.estimate ?? 0), 0);

  const add = () => run(async () => {
    const response = await changeMembershipAction(projectId, sprintId, "add", [...selected]);
    if (response.success) { setSelected(new Set()); setRefresh((value) => value + 1); }
    return response;
  });

  return (
    <div className="space-y-3 p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-secondary" />
          <label htmlFor="picker-search" className="sr-only">Search the backlog</label>
          <input id="picker-search" type="search" value={query} maxLength={100} placeholder="Search backlog by title or key"
            onChange={(event) => { setQuery(event.target.value); setPage(1); }} className={cn(control, "pl-9")} />
        </div>
        <button type="button" onClick={add} disabled={pending || selected.size === 0} className={cn(primaryButton, "shrink-0")}>
          {pending ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Plus aria-hidden="true" className="size-4" />}
          Add {selected.size || ""} to sprint{selected.size > 0 && ` · ${formatPoints(points)} pts`}
        </button>
      </div>
      <Result result={result} />
      {error ? <p role="alert" className="text-sm text-danger">{error}</p>
        : loading && items.length === 0 ? <div className="space-y-2" aria-hidden="true">{[0, 1, 2].map((key) => <div key={key} className="h-10 animate-pulse rounded-md bg-border/60" />)}</div>
          : items.length === 0 ? <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-text-secondary">{query ? "No backlog items match." : "The backlog is empty — every open item is already planned."}</p>
            : (
              <ul className={cn("divide-y divide-border rounded-lg border border-border", loading && "opacity-60")}>
                {items.map((item) => (
                  <li key={item.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-muted/50">
                      <input type="checkbox" checked={selected.has(item.id)} onChange={(event) => toggle(item.id, event.target.checked)} className="size-4 accent-[var(--primary)]" />
                      <WorkTypeIcon type={item.type} />
                      <IssueKey issueKey={item.issueKey} />
                      <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                      <span className="hidden text-xs text-text-secondary sm:inline">{item.assigneeName ?? "Unassigned"}</span>
                      <span className="w-10 text-right text-xs text-text-secondary tabular-nums">{item.estimate === null ? "–" : formatPoints(item.estimate)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
      {pageCount > 1 && (
        <div className="flex items-center justify-between text-xs text-text-secondary">
          <span>{total} eligible items</span>
          <div className="flex items-center gap-1">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page" className="rounded p-1 hover:bg-surface-muted disabled:opacity-30"><ChevronLeft aria-hidden="true" className="size-4" /></button>
            <span>Page {page} of {pageCount}</span>
            <button type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)} aria-label="Next page" className="rounded p-1 hover:bg-surface-muted disabled:opacity-30"><ChevronRight aria-hidden="true" className="size-4" /></button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Start / complete / cancel, each with an explicit confirmation. */
export function SprintLifecycle({ projectId, sprintId, status, startBlocker, unfinishedCount, carryTargets }: {
  projectId: string;
  sprintId: string;
  status: "PLANNING" | "ACTIVE";
  startBlocker: string | null;
  unfinishedCount: number;
  carryTargets: SprintOption[];
}) {
  const [mode, setMode] = useState<"idle" | "start" | "complete" | "cancel">("idle");
  const [carry, setCarry] = useState<"backlog" | "sprint" | "">(unfinishedCount === 0 ? "backlog" : "");
  const [target, setTarget] = useState("");
  const { result, pending, run } = useRun();
  const planned = carryTargets.filter((option) => option.status === "PLANNING");

  return (
    <div className="space-y-3">
      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          {status === "PLANNING" && (
            <>
              <button type="button" onClick={() => setMode("start")} disabled={Boolean(startBlocker)} className={primaryButton}><Play aria-hidden="true" className="size-4" />Start sprint</button>
              <button type="button" onClick={() => setMode("cancel")} className={dangerButton}><CircleSlash aria-hidden="true" className="size-4" />Cancel sprint</button>
            </>
          )}
          {status === "ACTIVE" && (
            <button type="button" onClick={() => setMode("complete")} className={primaryButton}><CalendarCheck2 aria-hidden="true" className="size-4" />Complete sprint</button>
          )}
        </div>
      )}
      {mode === "idle" && status === "PLANNING" && startBlocker && <p className="text-xs text-text-secondary">{startBlocker}</p>}

      {mode === "start" && (
        <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <p className="text-sm">Start this sprint now? Item statuses stay as they are; developers move their own work.</p>
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={() => run(() => startSprintAction(projectId, sprintId))} className={primaryButton}>{pending ? "Starting…" : "Start sprint"}</button>
            <button type="button" disabled={pending} onClick={() => setMode("idle")} className={secondaryButton}>Back</button>
          </div>
        </div>
      )}

      {mode === "cancel" && (
        <div className="space-y-3 rounded-lg border border-danger/30 bg-danger/5 p-4">
          <p className="text-sm">Cancel this planned sprint? Its items return to the backlog unchanged. The sprint stays in history.</p>
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={() => run(() => cancelSprintAction(projectId, sprintId))} className={cn(dangerButton, "border-danger bg-danger text-danger-foreground hover:bg-danger-hover")}>{pending ? "Cancelling…" : "Cancel sprint"}</button>
            <button type="button" disabled={pending} onClick={() => setMode("idle")} className={secondaryButton}>Back</button>
          </div>
        </div>
      )}

      {mode === "complete" && (
        <fieldset className="space-y-3 rounded-lg border border-border bg-surface-muted/40 p-4">
          <legend className="sr-only">Complete sprint</legend>
          {unfinishedCount === 0 ? (
            <p className="text-sm">All planned work is done or cancelled. Complete the sprint?</p>
          ) : (
            <>
              <p className="text-sm"><span className="font-semibold">{unfinishedCount} item{unfinishedCount === 1 ? " is" : "s are"} unfinished.</span> Choose where {unfinishedCount === 1 ? "it goes" : "they go"} — nothing is marked done or discarded.</p>
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="carry" checked={carry === "backlog"} onChange={() => setCarry("backlog")} className="accent-[var(--primary)]" />Return to the backlog</label>
              <label className={cn("flex items-center gap-2 text-sm", planned.length === 0 && "text-text-muted")}>
                <input type="radio" name="carry" disabled={planned.length === 0} checked={carry === "sprint"} onChange={() => setCarry("sprint")} className="accent-[var(--primary)]" />
                Move to a planned sprint{planned.length === 0 && " (create one first)"}
              </label>
              {carry === "sprint" && (
                <select aria-label="Planned sprint" value={target} onChange={(event) => setTarget(event.target.value)} className={cn(control, "h-9")}>
                  <option value="">Choose a planned sprint…</option>
                  {planned.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                </select>
              )}
            </>
          )}
          <div className="flex gap-2">
            <button type="button" disabled={pending || !carry || (carry === "sprint" && !target)}
              onClick={() => run(() => completeSprintAction(projectId, sprintId, carry || "backlog", carry === "sprint" ? target : null))} className={primaryButton}>
              {pending ? "Completing…" : "Complete sprint"}
            </button>
            <button type="button" disabled={pending} onClick={() => setMode("idle")} className={secondaryButton}>Back</button>
          </div>
        </fieldset>
      )}
      <Result result={result} />
    </div>
  );
}
