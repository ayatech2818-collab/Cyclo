"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition, type ReactNode } from "react";
import { Pencil, Plus, X } from "lucide-react";

import { card, control, label, primaryButton, secondaryButton } from "@/features/projects/components/styles";
import { cn } from "@/lib/utils/cn";

import { createSprintAction, setCapacityAction, updateSprintAction, type SprintActionResult } from "../actions";
import { GOAL_MAX, NAME_MAX } from "../logic";
import type { SprintDetail, SprintFieldErrors } from "../types";

const initial: SprintActionResult = { error: null, fieldErrors: {}, success: null };

function Field({ id, title, error, hint, children }: { id: string; title: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={label}>{title}</label>
      {children}
      {error ? <p id={`${id}-error`} className="mt-1.5 text-sm text-danger">{error}</p> : hint ? <p className="mt-1.5 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

function Fields({ prefix, errors, defaults, showCapacity, lockStart }: {
  prefix: string;
  errors: SprintFieldErrors;
  defaults: { name: string; goal: string; startDate: string; endDate: string; capacity: string };
  showCapacity: boolean;
  lockStart: boolean;
}) {
  const [start, setStart] = useState(defaults.startDate);
  const [end, setEnd] = useState(defaults.endDate);
  const invalid = (key: keyof SprintFieldErrors) => ({ "aria-invalid": Boolean(errors[key]) || undefined, "aria-describedby": errors[key] ? `${prefix}-${key}-error` : undefined });
  return (
    <>
      <Field id={`${prefix}-name`} title="Sprint name" error={errors.name}>
        <input id={`${prefix}-name`} name="name" required maxLength={NAME_MAX} defaultValue={defaults.name} placeholder="e.g. Sprint 12 – Checkout" autoComplete="off" {...invalid("name")} className={control} />
      </Field>
      <Field id={`${prefix}-goal`} title="Goal (optional)" error={errors.goal}>
        <textarea id={`${prefix}-goal`} name="goal" rows={2} maxLength={GOAL_MAX} defaultValue={defaults.goal} placeholder="What should this sprint achieve?" {...invalid("goal")} className={cn(control, "h-auto py-2")} />
      </Field>
      <div className={cn("grid gap-4", showCapacity ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <Field id={`${prefix}-startDate`} title="Start date" error={errors.startDate} hint={lockStart ? "Fixed once the sprint has started." : undefined}>
          {lockStart && <input type="hidden" name="startDate" value={start} />}
          <input id={`${prefix}-startDate`} name={lockStart ? undefined : "startDate"} type="date" value={start} max={end || undefined} disabled={lockStart}
            onChange={(event) => setStart(event.target.value)} {...invalid("startDate")} className={control} />
        </Field>
        <Field id={`${prefix}-endDate`} title="End date" error={errors.endDate}>
          <input id={`${prefix}-endDate`} name="endDate" type="date" value={end} min={start || undefined}
            onChange={(event) => setEnd(event.target.value)} {...invalid("endDate")} className={control} />
        </Field>
        {showCapacity && (
          <Field id={`${prefix}-capacity`} title="Capacity (points)" error={errors.capacity} hint="Optional planning target.">
            <input id={`${prefix}-capacity`} name="capacity" inputMode="decimal" defaultValue={defaults.capacity} placeholder="e.g. 30" {...invalid("capacity")} className={control} />
          </Field>
        )}
      </div>
    </>
  );
}

function Alert({ state }: { state: SprintActionResult }) {
  return state.error ? <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p> : null;
}

/** "New sprint" panel on the sprint list; opens the new sprint on success. */
export function CreateSprintPanel({ projectId, suggestedName }: { projectId: string; suggestedName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(async (previous: SprintActionResult, data: FormData) => {
    const result = await createSprintAction(projectId, previous, data);
    if (result.id) router.push(`/projects/${projectId}/sprints/${result.id}`);
    return result;
  }, initial);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={primaryButton}>
        <Plus aria-hidden="true" className="size-4" />
        New sprint
      </button>
    );
  }
  return (
    <form action={action} noValidate aria-busy={pending} className={cn(card, "w-full space-y-4 p-5")} aria-labelledby="new-sprint-title">
      <div className="flex items-center justify-between">
        <h2 id="new-sprint-title" className="text-base font-semibold">New sprint</h2>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded p-1 text-text-secondary hover:bg-surface-muted"><X aria-hidden="true" className="size-4" /></button>
      </div>
      <Alert state={state} />
      <Fields prefix="new-sprint" errors={state.fieldErrors} defaults={{ name: suggestedName, goal: "", startDate: "", endDate: "", capacity: "" }} showCapacity lockStart={false} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className={secondaryButton}>Cancel</button>
        <button type="submit" disabled={pending} className={primaryButton}>{pending ? "Creating…" : "Create sprint"}</button>
      </div>
    </form>
  );
}

export function EditSprintForm({ projectId, sprint }: { projectId: string; sprint: SprintDetail }) {
  const [editing, setEditing] = useState(false);
  const active = sprint.status === "ACTIVE";
  const [state, action, pending] = useActionState(async (previous: SprintActionResult, data: FormData) => {
    const result = await updateSprintAction(projectId, sprint.id, active, previous, data);
    if (result.success) setEditing(false);
    return result;
  }, initial);

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className={cn(secondaryButton, "h-9")}>
        <Pencil aria-hidden="true" className="size-4" />
        Edit sprint
      </button>
    );
  }
  return (
    <form action={action} noValidate aria-busy={pending} className={cn(card, "w-full space-y-4 p-5")} aria-label="Edit sprint">
      <Alert state={state} />
      <Fields prefix="edit-sprint" errors={state.fieldErrors} showCapacity={false} lockStart={active}
        defaults={{ name: sprint.name, goal: sprint.goal ?? "", startDate: sprint.startDate ?? "", endDate: sprint.endDate ?? "", capacity: "" }} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setEditing(false)} className={secondaryButton}>Cancel</button>
        <button type="submit" disabled={pending} className={primaryButton}>{pending ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}

export function CapacityEditor({ projectId, sprintId, capacity }: { projectId: string; sprintId: string; capacity: number | null }) {
  const [value, setValue] = useState(capacity === null ? "" : String(capacity));
  const [result, setResult] = useState<SprintActionResult | null>(null);
  const [pending, start] = useTransition();
  const changed = value.trim() !== (capacity === null ? "" : String(capacity));
  return (
    <form onSubmit={(event) => { event.preventDefault(); start(async () => setResult(await setCapacityAction(projectId, sprintId, value))); }} className="space-y-2">
      <label htmlFor="sprint-capacity" className={label}>Capacity (points)</label>
      <div className="flex gap-2">
        <input id="sprint-capacity" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Not set"
          aria-invalid={Boolean(result?.fieldErrors.capacity) || undefined} className={cn(control, "h-9")} />
        <button type="submit" disabled={pending || !changed} className={cn(secondaryButton, "h-9 shrink-0")}>{pending ? "Saving…" : "Save"}</button>
      </div>
      <p aria-live="polite" className="text-xs">
        {result?.fieldErrors.capacity ? <span className="text-danger">{result.fieldErrors.capacity}</span>
          : result?.error ? <span className="text-danger">{result.error}</span>
            : result?.success ? <span className="text-success">{result.success}</span>
              : <span className="text-text-muted">A planning target. Exceeding it shows a warning but never blocks planning.</span>}
      </p>
    </form>
  );
}
