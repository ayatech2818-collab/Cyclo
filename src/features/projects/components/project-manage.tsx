"use client";

import { useActionState, useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";

import { cn } from "@/lib/utils/cn";

import { assignProjectManagerAction, setProjectArchivedAction, type ProjectFormState } from "../actions";
import type { ProjectManagerOption } from "../types";
import { control, dangerButton, label, primaryButton, secondaryButton } from "./styles";

const initialState: ProjectFormState = { error: null, fieldErrors: {}, success: null };

function Feedback({ state }: { state: ProjectFormState }) {
  const error = state.error ?? Object.values(state.fieldErrors)[0];
  return (
    <div aria-live="polite" className="text-sm">
      {error && <p role="alert" className="text-danger">{error}</p>}
      {state.success && <p role="status" className="text-success">{state.success}</p>}
    </div>
  );
}

/** Archive (with an inline confirmation step) or restore. */
export function ArchiveControl({ projectId, archived, projectName }: { projectId: string; archived: boolean; projectName: string }) {
  const [state, action, pending] = useActionState(setProjectArchivedAction.bind(null, projectId, !archived), initialState);
  const [confirming, setConfirming] = useState(false);

  if (archived) {
    return (
      <form action={action} className="space-y-2">
        <button type="submit" disabled={pending} className={secondaryButton}>
          <ArchiveRestore aria-hidden="true" className="size-4" />
          {pending ? "Restoring…" : "Restore project"}
        </button>
        <Feedback state={state} />
      </form>
    );
  }

  return (
    <div className="space-y-2">
      {confirming ? (
        <form action={action} className="space-y-3 rounded-lg border border-danger/30 bg-danger/5 p-4" aria-labelledby="archive-confirm-title">
          <p id="archive-confirm-title" className="text-sm font-medium">Archive “{projectName}”?</p>
          <p className="text-sm text-text-secondary">The project becomes read-only and moves to the archived view. Nothing is deleted, and it can be restored later.</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className={cn(dangerButton, "border-danger bg-danger text-danger-foreground hover:bg-danger-hover")}>
              {pending ? "Archiving…" : "Archive project"}
            </button>
            <button type="button" disabled={pending} onClick={() => setConfirming(false)} className={secondaryButton}>Cancel</button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={dangerButton}>
          <Archive aria-hidden="true" className="size-4" />
          Archive project
        </button>
      )}
      <Feedback state={state} />
    </div>
  );
}

/** Super Admin only: assign or reassign the Project Manager. */
export function AssignManagerForm({ projectId, currentManagerId, options, disabled }: {
  projectId: string;
  currentManagerId: string;
  options: ProjectManagerOption[];
  disabled?: boolean;
}) {
  const [state, action, pending] = useActionState(assignProjectManagerAction.bind(null, projectId), initialState);
  const [selected, setSelected] = useState(options.some((option) => option.id === currentManagerId) ? currentManagerId : "");

  return (
    <form action={action} className="space-y-3">
      <div>
        <label htmlFor="assign-manager" className={label}>Reassign Project Manager</label>
        <select
          id="assign-manager" name="projectManagerId" required disabled={pending || disabled || options.length === 0}
          value={selected} onChange={(event) => setSelected(event.target.value)}
          className={control}
        >
          <option value="" disabled>{options.length ? "Select a Project Manager…" : "No active Project Managers"}</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>{option.fullName?.trim() || option.email || "Unnamed Project Manager"}</option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        disabled={pending || disabled || !selected || selected === currentManagerId}
        className={cn(primaryButton, "w-full")}
      >
        {pending ? "Saving…" : "Update Project Manager"}
      </button>
      <Feedback state={state} />
    </form>
  );
}
