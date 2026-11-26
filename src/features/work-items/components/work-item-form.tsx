"use client";

import Link from "next/link";
import { useActionState, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { card, control, label, primaryButton, secondaryButton } from "@/features/projects/components/styles";
import { PRIORITY_LABELS, PROJECT_PRIORITIES, type ProjectPriority } from "@/features/projects/types";
import { cn } from "@/lib/utils/cn";

import { createWorkItemAction, updateWorkItemAction, type WorkItemFormState } from "../actions";
import { PARENT_TYPES, TYPE_LABELS, type WorkItemDetail, type WorkItemField, type WorkItemType } from "../types";
import { DESCRIPTION_MAX, ESTIMATE_MAX, TITLE_MAX } from "../validation";
import { ParentPicker, type SelectedParent } from "./parent-picker";

const initial: WorkItemFormState = { error: null, fieldErrors: {}, success: null };

const TYPE_HINTS: Record<WorkItemType, string> = {
  EPIC: "A large body of work that groups related stories.",
  STORY: "A user-facing capability, optionally part of an epic.",
  TASK: "A unit of work, optionally part of a story.",
  SUBTASK: "A step of a task. Requires a parent task.",
  BUG: "A defect. Can stand alone or be linked to an epic, story or task.",
};

function Field({ id, title, error, hint, optional, children }: { id: string; title: string; error?: string; hint?: ReactNode; optional?: boolean; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={label}>
        {title}
        {optional && <span className="ml-1.5 text-xs font-normal text-text-muted">Optional</span>}
      </label>
      {children}
      {error ? <p id={`${id}-error`} className="mt-1.5 text-sm text-danger">{error}</p> : hint ? <p id={`${id}-hint`} className="mt-1.5 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

const describedBy = (id: string, error?: string, hint?: boolean) => (error ? `${id}-error` : hint ? `${id}-hint` : undefined);

function Alert({ state }: { state: WorkItemFormState }) {
  if (!state.error) return null;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>{state.error}</p>
    </div>
  );
}

type Content = { title: string; description: string; startDate: string; dueDate: string; estimate: string };

/** Title, description, dates and estimate: shared by create and edit. */
function ContentFields({ values, set, errors, pending, showEstimate }: {
  values: Content;
  set: (patch: Partial<Content>) => void;
  errors: Partial<Record<WorkItemField, string>>;
  pending: boolean;
  showEstimate: boolean;
}) {
  return (
    <>
      <Field id="wi-title" title="Title" error={errors.title}>
        <input id="wi-title" name="title" required maxLength={TITLE_MAX} autoComplete="off" disabled={pending} value={values.title}
          onChange={(event) => set({ title: event.target.value })}
          aria-invalid={Boolean(errors.title)} aria-describedby={describedBy("wi-title", errors.title)} className={control} />
      </Field>
      <Field id="wi-description" title="Description" optional error={errors.description}>
        <textarea id="wi-description" name="description" rows={6} maxLength={DESCRIPTION_MAX} disabled={pending} value={values.description}
          onChange={(event) => set({ description: event.target.value })}
          aria-invalid={Boolean(errors.description)} aria-describedby={describedBy("wi-description", errors.description)}
          className={cn(control, "h-auto py-2")} placeholder="Context, acceptance criteria, steps to reproduce…" />
      </Field>
      <div className={cn("grid gap-5", showEstimate ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <Field id="wi-start" title="Start date" optional error={errors.startDate}>
          <input id="wi-start" name="startDate" type="date" disabled={pending} value={values.startDate} max={values.dueDate || undefined}
            onChange={(event) => set({ startDate: event.target.value })}
            aria-invalid={Boolean(errors.startDate)} aria-describedby={describedBy("wi-start", errors.startDate)} className={control} />
        </Field>
        <Field id="wi-due" title="Due date" optional error={errors.dueDate}>
          <input id="wi-due" name="dueDate" type="date" disabled={pending} value={values.dueDate} min={values.startDate || undefined}
            onChange={(event) => set({ dueDate: event.target.value })}
            aria-invalid={Boolean(errors.dueDate)} aria-describedby={describedBy("wi-due", errors.dueDate)} className={control} />
        </Field>
        {showEstimate ? (
          <Field id="wi-estimate" title="Estimate" optional error={errors.estimate}>
            <input id="wi-estimate" name="estimate" inputMode="decimal" disabled={pending} value={values.estimate} placeholder="e.g. 3"
              onChange={(event) => set({ estimate: event.target.value })} max={ESTIMATE_MAX}
              aria-invalid={Boolean(errors.estimate)} aria-describedby={describedBy("wi-estimate", errors.estimate)} className={control} />
          </Field>
        ) : (
          <input type="hidden" name="estimate" value={values.estimate} />
        )}
      </div>
    </>
  );
}

export type AssigneeOption = { id: string; name: string };

export function CreateWorkItemForm({ projectId, allowedTypes, isManager, selfId, assignees, initialType, initialParent }: {
  projectId: string;
  allowedTypes: WorkItemType[];
  isManager: boolean;
  selfId: string;
  /** Active developer members. For a developer this is only themselves (if a member). */
  assignees: AssigneeOption[];
  initialType: WorkItemType;
  initialParent: SelectedParent | null;
}) {
  const [state, action, pending] = useActionState(createWorkItemAction.bind(null, projectId), initial);
  const [type, setType] = useState<WorkItemType>(initialType);
  const [parent, setParent] = useState<SelectedParent | null>(initialParent);
  const [content, setContent] = useState<Content>({ title: "", description: "", startDate: "", dueDate: "", estimate: "" });
  const [priority, setPriority] = useState<ProjectPriority>("medium");
  const [status, setStatus] = useState<"BACKLOG" | "TODO">("BACKLOG");
  const [assigneeId, setAssigneeId] = useState("");
  const errors = state.fieldErrors;

  const changeType = (next: WorkItemType) => {
    setType(next);
    // Drop a parent that the new type cannot have.
    if (parent && !PARENT_TYPES[next].allowed.includes(parent.type)) setParent(null);
  };

  return (
    <form action={action} className="space-y-6" aria-busy={pending} noValidate>
      <Alert state={state} />
      <section className={cn(card, "space-y-5 p-5 sm:p-6")} aria-labelledby="wi-basics">
        <h2 id="wi-basics" className="text-sm font-semibold tracking-wide text-text-secondary uppercase">Work item</h2>
        <fieldset aria-describedby={errors.type ? "wi-type-error" : "wi-type-hint"}>
          <legend className={label}>Type</legend>
          <div className="flex flex-wrap gap-2">
            {allowedTypes.map((option) => (
              <label key={option} className={cn("inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                type === option ? "border-primary bg-primary/10 text-primary" : "border-border text-text-secondary hover:bg-surface-muted")}>
                <input type="radio" name="type" value={option} checked={type === option} onChange={() => changeType(option)} disabled={pending} className="sr-only" />
                {TYPE_LABELS[option]}
              </label>
            ))}
          </div>
          {errors.type
            ? <p id="wi-type-error" className="mt-1.5 text-sm text-danger">{errors.type}</p>
            : <p id="wi-type-hint" className="mt-1.5 text-xs text-text-secondary">{TYPE_HINTS[type]}</p>}
        </fieldset>
        <ContentFields values={content} set={(patch) => setContent((current) => ({ ...current, ...patch }))} errors={errors} pending={pending} showEstimate={type !== "EPIC"} />
      </section>

      <section className={cn(card, "space-y-5 p-5 sm:p-6")} aria-labelledby="wi-planning">
        <h2 id="wi-planning" className="text-sm font-semibold tracking-wide text-text-secondary uppercase">Planning</h2>
        {PARENT_TYPES[type].allowed.length > 0 && (
          <Field id="wi-parent" title="Parent" optional={!PARENT_TYPES[type].required} error={errors.parentId}>
            <ParentPicker projectId={projectId} childType={type} value={parent} onChange={setParent} name="parentId"
              invalid={Boolean(errors.parentId)} describedBy={describedBy("wi-parent", errors.parentId)} disabled={pending} />
          </Field>
        )}
        <div className="grid gap-5 sm:grid-cols-3">
          <Field id="wi-status" title="Status" error={errors.status}>
            <select id="wi-status" name="status" value={status} onChange={(event) => setStatus(event.target.value as "BACKLOG" | "TODO")} disabled={pending} className={control}>
              <option value="BACKLOG">Backlog</option>
              <option value="TODO">To do</option>
            </select>
          </Field>
          <Field id="wi-priority" title="Priority" error={errors.priority}>
            <select id="wi-priority" name="priority" value={priority} onChange={(event) => setPriority(event.target.value as ProjectPriority)} disabled={pending} className={control}>
              {PROJECT_PRIORITIES.map((value) => <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>)}
            </select>
          </Field>
          <Field id="wi-assignee" title="Assignee" optional error={errors.assigneeId} hint={isManager ? undefined : "You can assign new work to yourself."}>
            <select id="wi-assignee" name="assigneeId" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} disabled={pending}
              aria-describedby={describedBy("wi-assignee", errors.assigneeId, !isManager)} className={control}>
              <option value="">Unassigned</option>
              {assignees.map((person) => <option key={person.id} value={person.id}>{person.id === selfId ? `${person.name} (me)` : person.name}</option>)}
            </select>
          </Field>
        </div>
      </section>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link href={`/projects/${projectId}/work`} className={secondaryButton}>Cancel</Link>
        <button type="submit" disabled={pending} className={primaryButton}>{pending ? "Creating…" : `Create ${TYPE_LABELS[type].toLowerCase()}`}</button>
      </div>
    </form>
  );
}

/** Inline editor for title, description, dates and estimate. */
export function EditWorkItemForm({ item, onDone }: { item: WorkItemDetail; onDone: () => void }) {
  const [state, action, pending] = useActionState(async (previous: WorkItemFormState, data: FormData) => {
    const result = await updateWorkItemAction(item.projectId, item.id, previous, data);
    if (result.success) onDone();
    return result;
  }, initial);
  const [content, setContent] = useState<Content>({
    title: item.title,
    description: item.description ?? "",
    startDate: item.startDate ?? "",
    dueDate: item.dueDate ?? "",
    estimate: item.estimate === null ? "" : String(item.estimate),
  });

  return (
    <form action={action} className="space-y-5" aria-busy={pending} noValidate>
      <Alert state={state} />
      <ContentFields values={content} set={(patch) => setContent((current) => ({ ...current, ...patch }))} errors={state.fieldErrors} pending={pending} showEstimate={item.type !== "EPIC"} />
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button type="button" onClick={onDone} disabled={pending} className={secondaryButton}>Cancel</button>
        <button type="submit" disabled={pending} className={primaryButton}>{pending ? "Saving…" : "Save changes"}</button>
      </div>
    </form>
  );
}
