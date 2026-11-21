"use client";

import { useActionState, useEffect, useId, useRef, type ReactNode, type FormEvent } from "react";
import {
  updateEmployeeDetailsAction, setEmployeeCodeAction, setEmployeeRoleAction,
  setEmployeeActiveAction, setGitOrganizerAction, type EmployeeActionState,
} from "../actions";
import { APP_ROLES, ROLE_LABELS, type EmployeeAdminDetail } from "../types";

type FormAction = (state: EmployeeActionState, data: FormData) => Promise<EmployeeActionState>;
const inputClass = "mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm disabled:opacity-60";
const buttonBase = "rounded-md px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60";
/** "danger" marks actions that remove access (deactivate, revoke), in the form and in its confirmation. */
const buttonTones = {
  primary: `${buttonBase} bg-primary text-primary-foreground hover:bg-primary-hover`,
  danger: `${buttonBase} bg-danger text-danger-foreground hover:bg-danger-hover`,
} as const;

/** Native modal provides focus containment, Escape handling, and focus restoration. */
export function ManagementForm({ title, action, children, confirmation, disabled = false, button = "Save changes", tone = "primary" }: {
  title: string; action: FormAction; children: ReactNode; confirmation?: string; disabled?: boolean; button?: string; tone?: keyof typeof buttonTones;
}) {
  const buttonClass = buttonTones[tone];
  const [state, formAction, pending] = useActionState(action, { error: null, success: null });
  const form = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const confirmed = useRef(false);
  const submitted = useRef(false);
  const heading = useId();
  const feedback = useId();
  useEffect(() => { if (!pending) submitted.current = false; }, [pending, state]);

  function submit(event: FormEvent<HTMLFormElement>) {
    if (pending || submitted.current || disabled) { event.preventDefault(); return; }
    if (confirmation && !confirmed.current) {
      event.preventDefault();
      dialog.current?.showModal();
      return;
    }
    confirmed.current = false;
    submitted.current = true;
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5 shadow-sm sm:p-6" aria-labelledby={heading}>
      <h2 id={heading} className="font-semibold">{title}</h2>
      <form ref={form} action={formAction} onSubmit={submit} aria-describedby={feedback} aria-busy={pending} className="mt-4 space-y-4">
        <fieldset disabled={pending || disabled} className="space-y-4">
          {children}
          <button type="submit" className={buttonClass}>{pending ? "Saving…" : button}</button>
        </fieldset>
        <div id={feedback} aria-live="polite" aria-atomic="true" className="text-sm">
          {state.error && <p role="alert" className="text-danger">{state.error}</p>}
          {state.success && <p role="status" className="text-success">{state.success}</p>}
        </div>
      </form>
      {confirmation && (
        <dialog ref={dialog} aria-labelledby={`${heading}-confirm`} className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-border bg-surface p-6 text-text-primary shadow-xl backdrop:bg-black/40">
          <h3 id={`${heading}-confirm`} className="font-semibold">Confirm {title.toLowerCase()}</h3>
          <p className="mt-3 text-sm text-text-secondary">{confirmation}</p>
          <div className="mt-6 flex justify-end gap-3">
            <button type="button" autoFocus onClick={() => dialog.current?.close()} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-surface-muted">Cancel</button>
            <button type="button" className={buttonClass} onClick={() => {
              dialog.current?.close();
              confirmed.current = true;
              form.current?.requestSubmit();
            }}>Confirm</button>
          </div>
        </dialog>
      )}
    </section>
  );
}

/** Only mounted by the Super Admin branch of the server-rendered detail page. */
export function EmployeeManagement({ employee, isSelf }: { employee: EmployeeAdminDetail; isSelf: boolean }) {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Manage employee</h2>
      {isSelf && <p className="text-sm text-text-secondary">You cannot change your own role or deactivate your account. Ask another active Super Admin.</p>}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <ManagementForm title="Edit profile" action={updateEmployeeDetailsAction.bind(null, employee.id)}>
          <label className="block text-sm font-medium">Full name
            <input name="fullName" required maxLength={200} defaultValue={employee.fullName ?? ""} autoComplete="name" className={inputClass} />
          </label>
          <label className="block text-sm font-medium">Avatar URL
            <input name="avatarUrl" type="url" pattern="[hH][tT][tT][pP][sS]://.*" maxLength={2048} defaultValue={employee.avatarUrl ?? ""} placeholder="https://…" className={inputClass} />
          </label>
          <p className="text-xs text-text-secondary">Use an HTTPS image URL, or leave blank to remove the avatar.</p>
        </ManagementForm>
        <ManagementForm title="Employee code" action={setEmployeeCodeAction.bind(null, employee.id)}>
          <label className="block text-sm font-medium">Employee code
            <input name="employeeCode" maxLength={32} defaultValue={employee.employeeCode ?? ""} className={inputClass} />
          </label>
          <p className="text-xs text-text-secondary">Up to 32 characters. Codes are case-sensitive. Leave blank to clear.</p>
        </ManagementForm>
        <ManagementForm title="Change role" action={setEmployeeRoleAction.bind(null, employee.id)} disabled={isSelf}
          confirmation="This changes the employee’s access and administrative permissions. Continue?">
          <label className="block text-sm font-medium">Role
            <select name="role" defaultValue={employee.role} className={inputClass}>
              {APP_ROLES.map(role => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
            </select>
          </label>
        </ManagementForm>
        <ManagementForm title={employee.isActive ? "Deactivate employee" : "Activate employee"}
          action={setEmployeeActiveAction.bind(null, employee.id)} disabled={isSelf}
          button={employee.isActive ? "Deactivate" : "Activate"}
          tone={employee.isActive ? "danger" : "primary"}
          confirmation={employee.isActive ? "The employee will lose access to CYCLO. Their account and profile will be retained. Continue?" : undefined}>
          <input type="hidden" name="isActive" value={String(!employee.isActive)} />
          <p className="text-sm text-text-secondary">Current status: {employee.isActive ? "Active" : "Inactive"}</p>
        </ManagementForm>
        <ManagementForm title="Git Organizer permission" action={setGitOrganizerAction.bind(null, employee.id)}
          button={employee.isGitOrganizer ? "Revoke permission" : "Grant permission"}
          tone={employee.isGitOrganizer ? "danger" : "primary"}
          confirmation={employee.isGitOrganizer ? "Revoke Git Organizer permission for this employee?" : "Grant Git Organizer permission to this employee?"}>
          <input type="hidden" name="isGitOrganizer" value={String(!employee.isGitOrganizer)} />
          <p className="text-sm text-text-secondary">{employee.isGitOrganizer ? "Granted" : "Not granted"}. This permission is separate from the employee’s role.</p>
        </ManagementForm>
      </div>
    </div>
  );
}
