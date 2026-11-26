"use client";

import Link from "next/link";
import { useState, useTransition, type DragEvent, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, GripVertical, Loader2, Plus, X } from "lucide-react";

import { ProjectPriorityBadge } from "@/features/projects/components/project-badges";
import { control, primaryButton, secondaryButton } from "@/features/projects/components/styles";
import { PRIORITY_LABELS, PROJECT_PRIORITIES } from "@/features/projects/types";
import { IssueKey, WorkStatusBadge, WorkTypeIcon } from "@/features/work-items/components/work-badges";
import { cn } from "@/lib/utils/cn";

import { bulkUpdateAction, moveBacklogItemAction, quickCreateAction, type BacklogActionResult } from "../actions";
import { formatPoints, groupBacklog, placementOf, reorder } from "../logic";
import type { BacklogGroup, BacklogItem, QuickCreateType } from "../types";

type Person = { id: string; name: string };

function Banner({ result, onClose }: { result: BacklogActionResult | null; onClose: () => void }) {
  if (!result?.error && !result?.success) return null;
  return (
    <div role={result.error ? "alert" : "status"} className={cn("flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm",
      result.error ? "border-danger/30 bg-danger/5 text-danger" : "border-success/30 bg-success/5 text-success")}>
      <span>{result.error ?? result.success}</span>
      <button type="button" onClick={onClose} aria-label="Dismiss" className="rounded p-1 hover:bg-surface-muted"><X aria-hidden="true" className="size-4" /></button>
    </div>
  );
}

/** Kept outside the board so it survives the board re-seeding after each create. */
export function QuickCreate({ projectId, types }: { projectId: string; types: QuickCreateType[] }) {
  const [type, setType] = useState<QuickCreateType>(types[0]);
  const [title, setTitle] = useState("");
  const [result, setResult] = useState<BacklogActionResult | null>(null);
  const [pending, start] = useTransition();

  // The input stays enabled while saving so focus remains for the next item.
  const submit = () =>
    !pending && start(async () => {
      const response = await quickCreateAction(projectId, type, title);
      setResult(response);
      if (response.success) setTitle("");
    });

  return (
    <div className="space-y-2">
      <form
        onSubmit={(event) => { event.preventDefault(); submit(); }}
        className="flex flex-col gap-2 rounded-xl border border-dashed border-border bg-surface p-2 sm:flex-row sm:items-center"
        aria-label="Quick create"
      >
        <div role="radiogroup" aria-label="Type" className="inline-flex shrink-0 rounded-lg bg-surface-muted p-1">
          {types.map((option) => (
            <button key={option} type="button" role="radio" aria-checked={type === option} onClick={() => setType(option)}
              className={cn("inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium", type === option ? "bg-surface text-text-primary shadow-sm" : "text-text-secondary")}>
              <WorkTypeIcon type={option} className="size-5" />
              {option === "TASK" ? "Task" : "Bug"}
            </button>
          ))}
        </div>
        <label htmlFor="bl-quick-title" className="sr-only">Title</label>
        <input id="bl-quick-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={255} aria-busy={pending}
          placeholder={`Add a ${type === "TASK" ? "task" : "bug"} to the bottom of the backlog…`} autoComplete="off"
          className={cn(control, "border-transparent bg-transparent focus-visible:border-primary")} />
        <button type="submit" disabled={pending || !title.trim()} className={cn(primaryButton, "h-9 shrink-0")}>
          {pending ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Plus aria-hidden="true" className="size-4" />}
          Add
        </button>
      </form>
      <Banner result={result} onClose={() => setResult(null)} />
    </div>
  );
}

function BulkBar({ projectId, ids, assignees, onDone }: { projectId: string; ids: string[]; assignees: Person[]; onDone: () => void }) {
  const [priority, setPriority] = useState("");
  const [assignee, setAssignee] = useState("");
  const [result, setResult] = useState<BacklogActionResult | null>(null);
  const [pending, start] = useTransition();

  const apply = () =>
    start(async () => {
      const response = await bulkUpdateAction(projectId, ids, priority, assignee);
      setResult(response);
      if (response.success) onDone();
    });

  return (
    <div className="sticky bottom-3 z-10 space-y-2">
      <div role="region" aria-label="Bulk edit" className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-surface p-3 shadow-lg sm:flex-row sm:items-center">
        <p className="text-sm font-medium whitespace-nowrap"><span className="tabular-nums">{ids.length}</span> selected</p>
        <label htmlFor="bl-bulk-priority" className="sr-only">Priority</label>
        <select id="bl-bulk-priority" value={priority} onChange={(event) => setPriority(event.target.value)} disabled={pending} className={cn(control, "h-9 sm:w-44")}>
          <option value="">Priority: unchanged</option>
          {PROJECT_PRIORITIES.map((value) => <option key={value} value={value}>Priority: {PRIORITY_LABELS[value]}</option>)}
        </select>
        <label htmlFor="bl-bulk-assignee" className="sr-only">Assignee</label>
        <select id="bl-bulk-assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)} disabled={pending} className={cn(control, "h-9 sm:w-52")}>
          <option value="">Assignee: unchanged</option>
          <option value="none">Assignee: unassign</option>
          {assignees.map((person) => <option key={person.id} value={person.id}>Assignee: {person.name}</option>)}
        </select>
        <div className="flex gap-2 sm:ml-auto">
          <button type="button" onClick={apply} disabled={pending || (!priority && !assignee)} className={cn(primaryButton, "h-9 flex-1")}>
            {pending ? "Applying…" : "Apply"}
          </button>
          <button type="button" onClick={onDone} disabled={pending} className={cn(secondaryButton, "h-9")}>Clear</button>
        </div>
      </div>
      <Banner result={result} onClose={() => setResult(null)} />
    </div>
  );
}

/**
 * Rank-ordered backlog. Managers drag rows (or use Alt+↑/↓) within a section;
 * the new position is saved immediately and rolled back if the server refuses.
 * Reordering never changes status or any other field.
 */
export function BacklogBoard({ projectId, items: initialItems, group, canPlan, assignees }: {
  projectId: string;
  items: BacklogItem[];
  group: BacklogGroup;
  canPlan: boolean;
  assignees: Person[];
}) {
  const [items, setItems] = useState(initialItems);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [result, setResult] = useState<BacklogActionResult | null>(null);
  const [, start] = useTransition();
  const sections = groupBacklog(items, group);
  const sectionOf = (id: string) => sections.find((section) => section.items.some((item) => item.id === id));

  const persist = (next: BacklogItem[], movedId: string) => {
    const section = groupBacklog(next, group).find((candidate) => candidate.items.some((item) => item.id === movedId));
    const placement = section ? placementOf(section.items.map((item) => item.id), movedId) : null;
    if (!placement) return;
    const previous = items;
    setItems(next);
    setSavingId(movedId);
    start(async () => {
      const response = await moveBacklogItemAction(projectId, movedId, placement.afterId, placement.beforeId);
      setSavingId(null);
      if (response.error) {
        setItems(previous);
        setResult(response);
      }
    });
  };

  const moveTo = (movedId: string, targetId: string, after: boolean) => {
    if (movedId === targetId || sectionOf(movedId) !== sectionOf(targetId)) return;
    const from = items.findIndex((item) => item.id === movedId);
    const without = items.filter((item) => item.id !== movedId);
    const targetIndex = without.findIndex((item) => item.id === targetId) + (after ? 1 : 0);
    const next = [...without];
    next.splice(targetIndex, 0, items[from]);
    if (next.every((item, index) => item.id === items[index].id)) return;
    persist(next, movedId);
  };

  const step = (id: string, direction: -1 | 1) => {
    const section = sectionOf(id);
    if (!section) return;
    const index = section.items.findIndex((item) => item.id === id);
    const target = section.items[index + direction];
    if (!target) return;
    const from = items.findIndex((item) => item.id === id);
    persist(reorder(items, from, items.findIndex((item) => item.id === target.id)), id);
  };

  const onDragOver = (event: DragEvent<HTMLLIElement>, target: BacklogItem) => {
    if (!dragId || sectionOf(dragId) !== sectionOf(target.id)) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    if (drop?.id !== target.id || drop.after !== after) setDrop({ id: target.id, after });
  };

  const onRowKey = (event: KeyboardEvent<HTMLLIElement>, id: string) => {
    if (!canPlan || !event.altKey) return;
    if (event.key === "ArrowUp") { event.preventDefault(); step(id, -1); }
    if (event.key === "ArrowDown") { event.preventDefault(); step(id, 1); }
  };

  const toggle = (ids: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });

  return (
    <div className="space-y-4">
      <Banner result={result} onClose={() => setResult(null)} />

      {sections.map((section) => {
        const ids = section.items.map((item) => item.id);
        const allSelected = ids.every((id) => selected.has(id));
        const points = section.items.reduce((sum, item) => sum + (item.estimate ?? 0), 0);
        return (
          <section key={section.key} aria-label={section.label} className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            <header className="flex items-center gap-3 border-b border-border bg-surface-muted/60 px-3 py-2 text-xs text-text-secondary sm:px-4">
              {canPlan && (
                <input type="checkbox" aria-label={`Select all in ${section.label}`} checked={allSelected} onChange={(event) => toggle(ids, event.target.checked)} className="size-4 accent-[var(--primary)]" />
              )}
              <span className="font-semibold tracking-wide text-text-primary uppercase">{section.label}</span>
              <span className="tabular-nums">{section.items.length} item{section.items.length === 1 ? "" : "s"} · {formatPoints(points)} pts</span>
            </header>
            <ul>
              {section.items.map((item, index) => (
                <li
                  key={item.id}
                  tabIndex={canPlan ? 0 : undefined}
                  onKeyDown={(event) => onRowKey(event, item.id)}
                  draggable={canPlan}
                  onDragStart={(event) => { setDragId(item.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.issueKey); }}
                  onDragEnd={() => { setDragId(null); setDrop(null); }}
                  onDragOver={(event) => onDragOver(event, item)}
                  onDragLeave={() => drop?.id === item.id && setDrop(null)}
                  onDrop={(event) => { event.preventDefault(); if (dragId && drop) moveTo(dragId, drop.id, drop.after); setDragId(null); setDrop(null); }}
                  aria-label={`${item.issueKey} ${item.title}`}
                  className={cn(
                    "group relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-2.5 last:border-b-0 focus-visible:outline-offset-[-2px] sm:px-4 md:grid-cols-[auto_minmax(0,1fr)_7.5rem_6.5rem_9rem_3.5rem] md:gap-x-4",
                    dragId === item.id && "opacity-40",
                    selected.has(item.id) && "bg-primary/5",
                    drop?.id === item.id && (drop.after ? "shadow-[inset_0_-2px_0_var(--primary)]" : "shadow-[inset_0_2px_0_var(--primary)]"),
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {canPlan && (
                      <>
                        <span aria-hidden="true" className="hidden cursor-grab text-text-muted active:cursor-grabbing md:inline"><GripVertical className="size-4" /></span>
                        <input type="checkbox" aria-label={`Select ${item.issueKey}`} checked={selected.has(item.id)} onChange={(event) => toggle([item.id], event.target.checked)} className="size-4 accent-[var(--primary)]" />
                      </>
                    )}
                    <WorkTypeIcon type={item.type} />
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    <IssueKey issueKey={item.issueKey} />
                    <Link href={`/projects/${projectId}/work/${item.id}`} draggable={false} className="min-w-0 truncate text-sm font-medium hover:text-primary">{item.title}</Link>
                    {item.epicKey && group !== "epic" && (
                      <span title={item.epicTitle ?? undefined} className="hidden shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary lg:inline">{item.epicKey}</span>
                    )}
                    {item.subtaskCount > 0 && <span className="hidden shrink-0 text-xs text-text-muted lg:inline">{item.subtaskCount} subtask{item.subtaskCount === 1 ? "" : "s"}</span>}
                    {savingId === item.id && <Loader2 aria-label="Saving position" className="size-3.5 shrink-0 animate-spin text-primary" />}
                    {canPlan && (
                      <span className="ml-auto hidden shrink-0 gap-0.5 group-focus-within:flex group-hover:flex">
                        <button type="button" onClick={() => step(item.id, -1)} disabled={index === 0} aria-label={`Move ${item.issueKey} up`} className="rounded p-1 text-text-secondary hover:bg-surface-muted disabled:opacity-30"><ArrowUp aria-hidden="true" className="size-3.5" /></button>
                        <button type="button" onClick={() => step(item.id, 1)} disabled={index === section.items.length - 1} aria-label={`Move ${item.issueKey} down`} className="rounded p-1 text-text-secondary hover:bg-surface-muted disabled:opacity-30"><ArrowDown aria-hidden="true" className="size-3.5" /></button>
                      </span>
                    )}
                  </div>
                  <div className="col-start-2 flex flex-wrap items-center gap-2 md:contents">
                    <span><WorkStatusBadge status={item.status} /></span>
                    <span><ProjectPriorityBadge priority={item.priority} /></span>
                    <span className="truncate text-sm text-text-secondary">{item.assigneeName ?? <span className="text-text-muted">Unassigned</span>}</span>
                    <span className="text-xs text-text-secondary tabular-nums md:text-right md:text-sm" title="Estimate">
                      {item.estimate === null ? <span className="text-text-muted">–</span> : formatPoints(item.estimate)}
                      <span className="md:hidden"> pts</span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {canPlan && selected.size > 0 && (
        <BulkBar projectId={projectId} ids={[...selected]} assignees={assignees} onDone={() => setSelected(new Set())} />
      )}
    </div>
  );
}
