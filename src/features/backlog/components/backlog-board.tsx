"use client";

import Link from "next/link";
import { useState, useTransition, type DragEvent, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, GripVertical, IterationCw, ListTree, Loader2, Plus, UserX, X } from "lucide-react";

import { buttonClass, control, primaryButton, secondaryButton } from "@/components/ui/styles";
import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { ProjectPriorityBadge } from "@/features/projects/components/project-badges";
import { changeMembershipAction } from "@/features/sprints/actions";
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
        className="flex items-center gap-2 rounded-xl border border-dashed border-border-strong bg-surface p-1.5 pl-2 transition-colors focus-within:border-primary/60"
        aria-label="Quick create"
      >
        <div role="radiogroup" aria-label="Type" className="inline-flex shrink-0 rounded-full bg-surface-muted p-0.5">
          {types.map((option) => (
            <button key={option} type="button" role="radio" aria-checked={type === option} onClick={() => setType(option)}
              aria-label={option === "TASK" ? "Task" : "Bug"}
              className={cn("inline-flex h-7 items-center gap-1.5 rounded-full px-1.5 text-xs font-medium sm:pr-2.5", type === option ? "bg-surface text-text-primary shadow-sm" : "text-text-secondary hover:text-text-primary")}>
              <WorkTypeIcon type={option} className="size-5 rounded-full" />
              <span className="hidden sm:inline">{option === "TASK" ? "Task" : "Bug"}</span>
            </button>
          ))}
        </div>
        <label htmlFor="bl-quick-title" className="sr-only">Title</label>
        <input id="bl-quick-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={255} aria-busy={pending}
          placeholder={`Add a ${type === "TASK" ? "task" : "bug"} to the bottom of the backlog…`} autoComplete="off"
          className={cn(control, "h-8 min-w-0 flex-1 border-transparent bg-transparent px-1 hover:border-transparent focus-visible:border-transparent")} />
        <button type="submit" disabled={pending || !title.trim()} className={cn(primaryButton, "h-8 shrink-0 px-3")}>
          {pending ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Plus aria-hidden="true" className="size-4" />}
          <span className="hidden sm:inline">Add</span><span className="sr-only sm:hidden">Add</span>
        </button>
      </form>
      <Banner result={result} onClose={() => setResult(null)} />
    </div>
  );
}

export type SprintChoice = { id: string; name: string; status: "PLANNING" | "ACTIVE" };

function BulkBar({ projectId, ids, points, assignees, sprints, onDone }: {
  projectId: string;
  ids: string[];
  points: number;
  assignees: Person[];
  /** Open sprints the selection can join (planned first); null when they could not be loaded. */
  sprints: SprintChoice[] | null;
  onDone: () => void;
}) {
  const [priority, setPriority] = useState("");
  const [assignee, setAssignee] = useState("");
  const [sprintId, setSprintId] = useState(sprints?.find((sprint) => sprint.status === "PLANNING")?.id ?? sprints?.[0]?.id ?? "");
  const [result, setResult] = useState<BacklogActionResult | null>(null);
  const [pending, start] = useTransition();

  const apply = () =>
    start(async () => {
      const response = await bulkUpdateAction(projectId, ids, priority, assignee);
      setResult(response);
      if (response.success) onDone();
    });

  // The same action the sprint planning page uses; the database decides what is allowed.
  const addToSprint = () =>
    start(async () => {
      const response = await changeMembershipAction(projectId, sprintId, "add", ids);
      setResult({ error: response.error, success: response.success });
      if (response.success) onDone();
    });

  const field = "flex min-w-0 flex-col gap-1";
  const caption = "text-[11px] font-medium text-text-muted";

  return (
    <div className="sticky bottom-3 z-10 space-y-2">
      <div role="region" aria-label="Bulk edit" className="rounded-2xl border border-primary/30 bg-surface/95 p-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-surface/85 sm:p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-sm font-semibold">
            <span className="tabular-nums">{ids.length}</span> selected
            <span className="ml-1.5 font-normal text-text-secondary tabular-nums">· {formatPoints(points)} pts</span>
          </p>
          <button type="button" onClick={onDone} disabled={pending} className={cn(secondaryButton, "h-8 px-3 text-xs")}>
            <X aria-hidden="true" className="size-3.5" />Clear selection
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-end">
          <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <legend className="sr-only">Edit selected items</legend>
            <div className={field}>
              <label htmlFor="bl-bulk-priority" className={caption}>Priority</label>
              <select id="bl-bulk-priority" value={priority} onChange={(event) => setPriority(event.target.value)} disabled={pending} className={cn(control, "h-9")}>
                <option value="">Unchanged</option>
                {PROJECT_PRIORITIES.map((value) => <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>)}
              </select>
            </div>
            <div className={field}>
              <label htmlFor="bl-bulk-assignee" className={caption}>Assignee</label>
              <select id="bl-bulk-assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)} disabled={pending} className={cn(control, "h-9")}>
                <option value="">Unchanged</option>
                <option value="none">Unassign</option>
                {assignees.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </select>
            </div>
            <button type="button" onClick={apply} disabled={pending || (!priority && !assignee)} className={cn(primaryButton, "h-9")}>
              {pending ? "Applying…" : "Apply"}
            </button>
          </fieldset>

          <span aria-hidden="true" className="hidden h-9 w-px self-end bg-border md:block" />

          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <div className={field}>
              <label htmlFor="bl-bulk-sprint" className={caption}>Add to sprint</label>
              {sprints === null ? (
                <p className="flex h-9 items-center text-xs text-danger">Sprints could not be loaded.</p>
              ) : sprints.length === 0 ? (
                <p className="flex h-9 items-center text-xs text-text-muted">
                  No open sprint.&nbsp;<Link href={`/projects/${projectId}/sprints`} className="font-medium text-primary-strong hover:underline">Create one</Link>
                </p>
              ) : (
                <select id="bl-bulk-sprint" value={sprintId} onChange={(event) => setSprintId(event.target.value)} disabled={pending} className={cn(control, "h-9")}>
                  {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}{sprint.status === "ACTIVE" ? " (active)" : " (planned)"}</option>)}
                </select>
              )}
            </div>
            {sprints && sprints.length > 0 && (
              <button type="button" onClick={addToSprint} disabled={pending || !sprintId} className={cn(buttonClass("accent"), "h-9")}>
                <IterationCw aria-hidden="true" className="size-4" />Add
              </button>
            )}
          </div>
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
export function BacklogBoard({ projectId, items: initialItems, group, canPlan, assignees, sprints }: {
  projectId: string;
  items: BacklogItem[];
  group: BacklogGroup;
  canPlan: boolean;
  assignees: Person[];
  sprints: SprintChoice[] | null;
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
        const unestimated = section.items.filter((item) => item.estimate === null).length;
        const epicSection = group === "epic";
        return (
          <section key={section.key} aria-label={section.label} className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            <header className={cn("flex items-center gap-3 border-b border-border px-3 py-2.5 text-xs text-text-secondary sm:px-4", epicSection && section.key !== "none" ? "bg-accent/5" : "bg-surface-muted/60")}>
              {canPlan && (
                <input type="checkbox" aria-label={`Select all in ${section.label}`} checked={allSelected} onChange={(event) => toggle(ids, event.target.checked)} className="size-4 accent-[var(--primary)]" />
              )}
              {epicSection && section.key !== "none" && <WorkTypeIcon type="EPIC" />}
              <span className={cn("min-w-0 truncate font-semibold text-text-primary", group === "none" && "tracking-wide uppercase")}>{section.label}</span>
              <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
                <span>{section.items.length} item{section.items.length === 1 ? "" : "s"}</span>
                <span className="rounded-full bg-surface px-2 py-0.5 font-semibold text-text-primary ring-1 ring-border">{formatPoints(points)} pts</span>
                {unestimated > 0 && <span className="hidden text-warning sm:inline">{unestimated} not estimated</span>}
              </span>
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
                    "group relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5 border-b border-border px-3 py-2 last:border-b-0 transition-colors duration-100 hover:bg-surface-muted/50 focus-visible:outline-offset-[-2px] sm:px-4 md:grid-cols-[auto_minmax(0,1fr)_7.5rem_6.5rem_10rem_3.75rem] md:gap-x-4",
                    dragId === item.id && "opacity-40",
                    selected.has(item.id) && "bg-primary-soft/70 hover:bg-primary-soft",
                    drop?.id === item.id && (drop.after ? "shadow-[inset_0_-2px_0_var(--primary)]" : "shadow-[inset_0_2px_0_var(--primary)]"),
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {canPlan && (
                      <>
                        <span aria-hidden="true" className="hidden cursor-grab text-text-muted opacity-50 transition-opacity group-hover:opacity-100 active:cursor-grabbing md:inline"><GripVertical className="size-4" /></span>
                        <input type="checkbox" aria-label={`Select ${item.issueKey}`} checked={selected.has(item.id)} onChange={(event) => toggle([item.id], event.target.checked)} className="size-4 accent-[var(--primary)]" />
                      </>
                    )}
                    <WorkTypeIcon type={item.type} />
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    <IssueKey issueKey={item.issueKey} />
                    <Link href={`/projects/${projectId}/work/${item.id}`} draggable={false} className="min-w-0 truncate text-sm font-medium hover:text-primary-strong">{item.title}</Link>
                    {item.epicKey && group !== "epic" && (
                      <span title={item.epicTitle ?? undefined} className="hidden shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent lg:inline-flex">
                        <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />{item.epicKey}
                      </span>
                    )}
                    {item.subtaskCount > 0 && (
                      <span className="hidden shrink-0 items-center gap-1 text-xs text-text-muted lg:inline-flex">
                        <ListTree aria-hidden="true" className="size-3.5" />{item.subtaskCount}<span className="sr-only"> subtask{item.subtaskCount === 1 ? "" : "s"}</span>
                      </span>
                    )}
                    {savingId === item.id && <Loader2 aria-label="Saving position" className="size-3.5 shrink-0 animate-spin text-primary" />}
                    {canPlan && (
                      <span className="ml-auto hidden shrink-0 gap-0.5 group-focus-within:flex group-hover:flex">
                        <button type="button" onClick={() => step(item.id, -1)} disabled={index === 0} aria-label={`Move ${item.issueKey} up`} className="rounded-full p-1 text-text-secondary hover:bg-surface hover:text-text-primary disabled:opacity-30"><ArrowUp aria-hidden="true" className="size-3.5" /></button>
                        <button type="button" onClick={() => step(item.id, 1)} disabled={index === section.items.length - 1} aria-label={`Move ${item.issueKey} down`} className="rounded-full p-1 text-text-secondary hover:bg-surface hover:text-text-primary disabled:opacity-30"><ArrowDown aria-hidden="true" className="size-3.5" /></button>
                      </span>
                    )}
                  </div>
                  <div className="col-start-2 flex items-center gap-x-1.5 sm:gap-x-2 md:contents">
                    <span><WorkStatusBadge status={item.status} /></span>
                    <span><ProjectPriorityBadge priority={item.priority} /></span>
                    <span className="ml-auto flex shrink-0 items-center gap-2 text-sm text-text-secondary md:ml-0 md:min-w-0 md:shrink">
                      {item.assigneeName ? (
                        <>
                          <EmployeeAvatar fullName={item.assigneeName} email={null} avatarUrl={null} size="sm" />
                          <span className="hidden truncate md:inline">{item.assigneeName}</span>
                          <span className="sr-only md:hidden">{item.assigneeName}</span>
                        </>
                      ) : (
                        <>
                          <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-warning/60 text-warning"><UserX className="size-3.5" /></span>
                          <span className="hidden text-xs text-warning md:inline">Unassigned</span>
                          <span className="sr-only md:hidden">Unassigned</span>
                        </>
                      )}
                    </span>
                    <span className="shrink-0 md:text-right" title={item.estimate === null ? "Not estimated" : "Estimate (points)"}>
                      {item.estimate === null ? (
                        <span className="inline-flex h-6 min-w-7 items-center justify-center rounded-full border border-dashed border-warning/60 px-2 text-[11px] font-semibold text-warning">
                          <span aria-hidden="true">?</span><span className="sr-only">Not estimated</span>
                        </span>
                      ) : (
                        <span className="inline-flex h-6 min-w-7 items-center justify-center rounded-full bg-surface-muted px-2 text-xs font-semibold text-text-primary tabular-nums">
                          {formatPoints(item.estimate)}<span className="ml-0.5 font-normal text-text-muted">pt</span>
                        </span>
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {canPlan && selected.size > 0 && (
        <BulkBar projectId={projectId} ids={[...selected]} assignees={assignees} sprints={sprints}
          points={items.filter((item) => selected.has(item.id)).reduce((sum, item) => sum + (item.estimate ?? 0), 0)}
          onDone={() => setSelected(new Set())} />
      )}
    </div>
  );
}
