"use client";

import Link from "next/link";
import { useActionState, useState, type ReactNode } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils/cn";

import { createProjectAction, updateProjectAction, type ProjectFormState } from "../actions";
import {
  PRIORITY_LABELS,
  PROJECT_PRIORITIES,
  PROJECT_STATUSES,
  STATUS_LABELS,
  type ProjectDetail,
  type ProjectField,
  type ProjectManagerOption,
  type ProjectPriority,
  type ProjectStatus,
} from "../types";
import { DESCRIPTION_MAX, KEY_MAX, NAME_MAX, normalizeProjectKey, suggestProjectKey } from "../validation";
import { ProjectKeyBadge } from "./project-badges";
import { card, control, label, primaryButton, secondaryButton } from "./styles";

const initialState: ProjectFormState = { error: null, fieldErrors: {}, success: null };

function Field({ id, title, hint, error, optional, children }: {
  id: string;
  title: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={label}>
        {title}
        {optional && <span className="ml-1.5 text-xs font-normal text-text-muted">Optional</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-danger">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-text-secondary">{hint}</p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, error?: string, hint?: boolean) {
  return error ? `${id}-error` : hint ? `${id}-hint` : undefined;
}

function FormAlert({ state }: { state: ProjectFormState }) {
  if (!state.error) return null;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>{state.error}</p>
    </div>
  );
}

type CommonValues = { name: string; description: string; priority: ProjectPriority; startDate: string; targetDate: string };

function CommonFields({ values, set, errors, pending, nameExtra }: {
  values: CommonValues;
  set: (patch: Partial<CommonValues>) => void;
  errors: Partial<Record<ProjectField, string>>;
  pending: boolean;
  nameExtra?: (name: string) => void;
}) {
  return (
    <>
      <Field id="project-name" title="Project name" error={errors.name}>
        <input
          id="project-name" name="name" required maxLength={NAME_MAX} autoComplete="off" disabled={pending}
          value={values.name}
          onChange={(event) => { set({ name: event.target.value }); nameExtra?.(event.target.value); }}
          aria-invalid={Boolean(errors.name)} aria-describedby={describedBy("project-name", errors.name)}
          className={control}
        />
      </Field>
      <Field id="project-description" title="Description" optional error={errors.description} hint={`${values.description.length.toLocaleString("en-US")} / ${DESCRIPTION_MAX.toLocaleString("en-US")}`}>
        <textarea
          id="project-description" name="description" rows={5} maxLength={DESCRIPTION_MAX} disabled={pending}
          value={values.description}
          onChange={(event) => set({ description: event.target.value })}
          aria-invalid={Boolean(errors.description)} aria-describedby={describedBy("project-description", errors.description, true)}
          className={cn(control, "h-auto py-2")}
          placeholder="What is this project about? Goals, scope, stakeholders…"
        />
      </Field>
      <Field id="project-priority" title="Priority" error={errors.priority}>
        <select
          id="project-priority" name="priority" required disabled={pending}
          value={values.priority}
          onChange={(event) => set({ priority: event.target.value as ProjectPriority })}
          aria-invalid={Boolean(errors.priority)} aria-describedby={describedBy("project-priority", errors.priority)}
          className={control}
        >
          {PROJECT_PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>)}
        </select>
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="project-start" title="Start date" optional error={errors.startDate}>
          <input
            id="project-start" name="startDate" type="date" disabled={pending}
            value={values.startDate} max={values.targetDate || undefined}
            onChange={(event) => set({ startDate: event.target.value })}
            aria-invalid={Boolean(errors.startDate)} aria-describedby={describedBy("project-start", errors.startDate)}
            className={control}
          />
        </Field>
        <Field id="project-target" title="Target date" optional error={errors.targetDate}>
          <input
            id="project-target" name="targetDate" type="date" disabled={pending}
            value={values.targetDate} min={values.startDate || undefined}
            onChange={(event) => set({ targetDate: event.target.value })}
            aria-invalid={Boolean(errors.targetDate)} aria-describedby={describedBy("project-target", errors.targetDate)}
            className={control}
          />
        </Field>
      </div>
    </>
  );
}

function managerName(option: ProjectManagerOption) {
  return option.fullName?.trim() || option.email || "Unnamed Project Manager";
}

/**
 * Create form. Super Admins choose an active Project Manager; Project Managers
 * see no selector because the database assigns them automatically.
 */
export function CreateProjectForm({ managerOptions, selfName }: { managerOptions: ProjectManagerOption[] | null; selfName: string }) {
  const [state, action, pending] = useActionState(createProjectAction, initialState);
  const [values, setValues] = useState<CommonValues>({ name: "", description: "", priority: "medium", startDate: "", targetDate: "" });
  const [projectKey, setProjectKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [managerId, setManagerId] = useState("");
  const errors = state.fieldErrors;
  const isSuperAdmin = managerOptions !== null;
  const noManagers = isSuperAdmin && managerOptions.length === 0;
  const suggestion = suggestProjectKey(values.name);

  return (
    <form action={action} className="space-y-6" aria-busy={pending} noValidate>
      <FormAlert state={state} />
      <section className={cn(card, "space-y-5 p-5 sm:p-6")} aria-labelledby="project-basics">
        <h2 id="project-basics" className="text-sm font-semibold tracking-wide text-text-secondary uppercase">Basics</h2>
        <CommonFields
          values={values}
          set={(patch) => setValues((current) => ({ ...current, ...patch }))}
          errors={errors}
          pending={pending}
          nameExtra={(name) => { if (!keyEdited) setProjectKey(suggestProjectKey(name)); }}
        />
        <Field
          id="project-key" title="Project key" error={errors.projectKey}
          hint="2–10 letters or digits, starting with a letter. Used as the prefix for future work items and cannot be changed later."
        >
          <div className="flex gap-2">
            <input
              id="project-key" name="projectKey" required maxLength={KEY_MAX} autoComplete="off" spellCheck={false} disabled={pending}
              value={projectKey}
              onChange={(event) => { setKeyEdited(true); setProjectKey(normalizeProjectKey(event.target.value).replace(/[^A-Z0-9]/g, "")); }}
              aria-invalid={Boolean(errors.projectKey)} aria-describedby={describedBy("project-key", errors.projectKey, true)}
              className={cn(control, "font-mono tracking-wider uppercase")}
              placeholder="e.g. WEB"
            />
            {keyEdited && suggestion && suggestion !== projectKey && (
              <button
                type="button" disabled={pending}
                onClick={() => { setProjectKey(suggestion); setKeyEdited(false); }}
                className={cn(secondaryButton, "shrink-0 px-3")}
                title="Use the suggested key"
              >
                <Sparkles aria-hidden="true" className="size-4 text-accent" />
                <span className="font-mono">{suggestion}</span>
                <span className="sr-only">Use suggested key</span>
              </button>
            )}
          </div>
        </Field>
      </section>

      <section className={cn(card, "space-y-4 p-5 sm:p-6")} aria-labelledby="project-ownership">
        <h2 id="project-ownership" className="text-sm font-semibold tracking-wide text-text-secondary uppercase">Ownership</h2>
        {isSuperAdmin ? (
          <Field
            id="project-manager" title="Project Manager" error={errors.projectManagerId}
            hint={noManagers ? undefined : "Only active Project Managers can be assigned."}
          >
            <select
              id="project-manager" name="projectManagerId" required disabled={pending || noManagers}
              value={managerId} onChange={(event) => setManagerId(event.target.value)}
              aria-invalid={Boolean(errors.projectManagerId)} aria-describedby={describedBy("project-manager", errors.projectManagerId, !noManagers)}
              className={control}
            >
              <option value="" disabled>Select a Project Manager…</option>
              {managerOptions.map((option) => (
                <option key={option.id} value={option.id}>{managerName(option)}{option.email && option.fullName ? ` · ${option.email}` : ""}</option>
              ))}
            </select>
            {noManagers && (
              <p className="mt-1.5 text-sm text-warning">
                There are no active Project Managers. <Link href="/employees" className="font-medium underline">Assign the role to an employee</Link> first.
              </p>
            )}
          </Field>
        ) : (
          <div className="rounded-lg bg-surface-muted px-4 py-3 text-sm">
            <p className="font-medium">{selfName}</p>
            <p className="text-text-secondary">You will be the Project Manager of this project.</p>
          </div>
        )}
      </section>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link href="/projects" className={secondaryButton}>Cancel</Link>
        <button type="submit" disabled={pending || noManagers} className={primaryButton}>{pending ? "Creating…" : "Create project"}</button>
      </div>
    </form>
  );
}

export function EditProjectForm({ project }: { project: ProjectDetail }) {
  const [state, action, pending] = useActionState(updateProjectAction.bind(null, project.id), initialState);
  const [values, setValues] = useState<CommonValues>({
    name: project.name,
    description: project.description ?? "",
    priority: project.priority,
    startDate: project.startDate ?? "",
    targetDate: project.targetDate ?? "",
  });
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const errors = state.fieldErrors;

  return (
    <form action={action} className="space-y-6" aria-busy={pending} noValidate>
      <FormAlert state={state} />
      <section className={cn(card, "space-y-5 p-5 sm:p-6")} aria-labelledby="project-details">
        <div className="flex items-center justify-between gap-3">
          <h2 id="project-details" className="text-sm font-semibold tracking-wide text-text-secondary uppercase">Details</h2>
          <span className="flex items-center gap-2 text-xs text-text-secondary">Key <ProjectKeyBadge projectKey={project.projectKey} /></span>
        </div>
        <CommonFields values={values} set={(patch) => setValues((current) => ({ ...current, ...patch }))} errors={errors} pending={pending} />
        <Field id="project-status" title="Status" error={errors.status}>
          <select
            id="project-status" name="status" required disabled={pending}
            value={status} onChange={(event) => setStatus(event.target.value as ProjectStatus)}
            aria-invalid={Boolean(errors.status)} aria-describedby={describedBy("project-status", errors.status)}
            className={control}
          >
            {PROJECT_STATUSES.map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
          </select>
        </Field>
      </section>
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link href={`/projects/${project.id}`} className={secondaryButton}>Cancel</Link>
        <button type="submit" disabled={pending} className={primaryButton}>{pending ? "Saving…" : "Save changes"}</button>
      </div>
    </form>
  );
}
