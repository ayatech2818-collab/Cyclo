"use client";

import { useState, useTransition } from "react";
import { Archive, ArchiveRestore, ArrowRight, Pencil } from "lucide-react";

import { control, dangerButton, label, primaryButton, secondaryButton } from "@/features/projects/components/styles";
import { PRIORITY_LABELS, PROJECT_PRIORITIES } from "@/features/projects/types";
import { cn } from "@/lib/utils/cn";

import { assignAction, changePriorityAction, changeStatusAction, setArchivedAction, setHierarchyAction, type WorkItemFormState } from "../actions";
import { PARENT_TYPES, TYPE_LABELS, WORK_ITEM_TYPES, WORK_STATUS_LABELS, type WorkItemDetail, type WorkItemStatus, type WorkItemType } from "../types";
import { ParentPicker, type SelectedParent } from "./parent-picker";
import { WorkStatusBadge } from "./work-badges";
import { EditWorkItemForm, type AssigneeOption } from "./work-item-form";

function Message({ state }: { state: WorkItemFormState | null }) {
  const error = state?.error ?? (state ? Object.values(state.fieldErrors)[0] : null);
  return (
    <div aria-live="polite" className="min-h-0 text-xs">
      {error && <p role="alert" className="text-danger">{error}</p>}
      {state?.success && <p role="status" className="text-success">{state.success}</p>}
    </div>
  );
}

/** Runs a server action and keeps its result for the message line. */
function useAction() {
  const [state, setState] = useState<WorkItemFormState | null>(null);
  const [pending, start] = useTransition();
  const run = (action: () => Promise<WorkItemFormState>) => start(async () => setState(await action()));
  return { state, pending, run };
}

export function StatusControl({ item, nextStatuses }: { item: WorkItemDetail; nextStatuses: WorkItemStatus[] }) {
  const { state, pending, run } = useAction();
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <WorkStatusBadge status={item.status} />
        {item.status === "BLOCKED" && item.blockedFromStatus && (
          <span className="text-xs text-text-secondary">was {WORK_STATUS_LABELS[item.blockedFromStatus]}</span>
        )}
      </div>
      {nextStatuses.length > 0 ? (
        <div role="group" aria-label="Move to status" className="flex flex-wrap gap-2">
          {nextStatuses.map((status) => (
            <button
              key={status}
              type="button"
              disabled={pending}
              onClick={() => run(() => changeStatusAction(item.projectId, item.id, status))}
              className={cn(secondaryButton, "h-8 gap-1.5 px-2.5 text-xs", status === "CANCELLED" && "text-danger", status === "DONE" && "text-success")}
            >
              <ArrowRight aria-hidden="true" className="size-3.5" />
              {WORK_STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-text-muted">No status changes available to you.</p>
      )}
      <Message state={state} />
    </div>
  );
}

export function PriorityControl({ item }: { item: WorkItemDetail }) {
  const { state, pending, run } = useAction();
  return (
    <div className="space-y-1.5">
      <label htmlFor="wi-priority-control" className={label}>Priority</label>
      <select id="wi-priority-control" value={item.priority} disabled={pending}
        onChange={(event) => run(() => changePriorityAction(item.projectId, item.id, event.target.value))} className={control}>
        {PROJECT_PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>)}
      </select>
      <Message state={state} />
    </div>
  );
}

export function AssigneeControl({ item, assignees }: { item: WorkItemDetail; assignees: AssigneeOption[] }) {
  const { state, pending, run } = useAction();
  const current = item.assigneeId ?? "";
  const known = assignees.some((person) => person.id === current);
  return (
    <div className="space-y-1.5">
      <label htmlFor="wi-assignee-control" className={label}>Assignee</label>
      <select id="wi-assignee-control" value={current} disabled={pending}
        onChange={(event) => run(() => assignAction(item.projectId, item.id, event.target.value))} className={control}>
        <option value="">Unassigned</option>
        {/* A former member stays visible (selected) until reassigned. */}
        {current && !known && <option value={current} disabled>{item.assigneeName ?? "Former member"} (not on team)</option>}
        {assignees.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select>
      <p className="text-xs text-text-muted">Active developers on this project’s team.</p>
      <Message state={state} />
    </div>
  );
}

export function HierarchyControl({ item }: { item: WorkItemDetail }) {
  const { state, pending, run } = useAction();
  const [type, setType] = useState<WorkItemType>(item.type);
  const [parent, setParent] = useState<SelectedParent | null>(item.parent);
  const changed = type !== item.type || (parent?.id ?? null) !== (item.parent?.id ?? null);
  const needsParent = PARENT_TYPES[type].required && !parent;

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="wi-type-control" className={label}>Type</label>
        <select id="wi-type-control" value={type} disabled={pending}
          onChange={(event) => {
            const next = event.target.value as WorkItemType;
            setType(next);
            if (parent && !PARENT_TYPES[next].allowed.includes(parent.type)) setParent(null);
          }} className={control}>
          {WORK_ITEM_TYPES.map((value) => <option key={value} value={value}>{TYPE_LABELS[value]}</option>)}
        </select>
      </div>
      <div>
        <span className={label}>Parent</span>
        <ParentPicker projectId={item.projectId} childType={type} excludeId={item.id} value={parent} onChange={setParent} disabled={pending} />
        {needsParent && <p className="mt-1.5 text-xs text-warning">A subtask needs a parent task.</p>}
      </div>
      {changed && (
        <div className="flex gap-2">
          <button type="button" disabled={pending || needsParent} onClick={() => run(() => setHierarchyAction(item.projectId, item.id, type, parent?.id ?? null))} className={cn(primaryButton, "h-9 flex-1")}>
            {pending ? "Saving…" : "Save"}
          </button>
          <button type="button" disabled={pending} onClick={() => { setType(item.type); setParent(item.parent); }} className={cn(secondaryButton, "h-9")}>Reset</button>
        </div>
      )}
      <Message state={state} />
    </div>
  );
}

export function WorkItemArchiveControl({ item }: { item: WorkItemDetail }) {
  const { state, pending, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  const archived = Boolean(item.archivedAt);

  if (archived) {
    return (
      <div className="space-y-2">
        <button type="button" disabled={pending} onClick={() => run(() => setArchivedAction(item.projectId, item.id, false))} className={secondaryButton}>
          <ArchiveRestore aria-hidden="true" className="size-4" />
          {pending ? "Restoring…" : "Restore"}
        </button>
        <Message state={state} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {confirming ? (
        <div className="space-y-3 rounded-lg border border-danger/30 bg-danger/5 p-3">
          <p className="text-sm">Archive {item.issueKey}? It becomes read-only and its key is never reused.</p>
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={() => run(async () => { const result = await setArchivedAction(item.projectId, item.id, true); setConfirming(false); return result; })}
              className={cn(dangerButton, "h-9 border-danger bg-danger text-danger-foreground hover:bg-danger-hover")}>
              {pending ? "Archiving…" : "Archive"}
            </button>
            <button type="button" disabled={pending} onClick={() => setConfirming(false)} className={cn(secondaryButton, "h-9")}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={dangerButton}>
          <Archive aria-hidden="true" className="size-4" />
          Archive
        </button>
      )}
      <Message state={state} />
    </div>
  );
}

/** Title + description display with an inline editor for permitted users. */
export function WorkItemContent({ item, canEdit }: { item: WorkItemDetail; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <EditWorkItemForm item={item} onDone={() => setEditing(false)} />;
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold">Description</h2>
        {canEdit && (
          <button type="button" onClick={() => setEditing(true)} className={cn(secondaryButton, "h-8 px-3 text-xs")}>
            <Pencil aria-hidden="true" className="size-3.5" />
            Edit
          </button>
        )}
      </div>
      {item.description ? (
        <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-text-secondary">{item.description}</p>
      ) : (
        <p className="mt-3 text-sm text-text-muted">No description.</p>
      )}
    </div>
  );
}
