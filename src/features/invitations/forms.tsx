"use client";
import { useActionState } from "react";
import { APP_ROLES, ROLE_LABELS } from "@/features/employees/types";
import { ManagementForm } from "@/features/employees/components/employee-management";
import { inviteEmployeeAction, resendInvitationAction, revokeInvitationAction } from "./actions";
import { setOnboardingPassword, completeOnboarding } from "./onboarding-actions";
import type { Invitation, InvitationFormState } from "./types";

const input = "mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm disabled:opacity-60";
export function InviteEmployeeForm() {
  return <ManagementForm title="Invite employee" action={inviteEmployeeAction} button="Send invitation">
    <label className="block text-sm font-medium">Full name<input name="fullName" required maxLength={200} autoComplete="name" className={input} /></label>
    <label className="block text-sm font-medium">Email<input name="email" type="email" required maxLength={254} autoComplete="email" className={input} /></label>
    <label className="block text-sm font-medium">Role<select name="role" defaultValue="DEVELOPER" className={input}>{APP_ROLES.map(role => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}</select></label>
    <p className="text-xs text-text-secondary">The employee receives a Supabase invitation and must complete onboarding before gaining access. Links expire after one hour.</p>
  </ManagementForm>;
}
export function InvitationControls({ invitation }: { invitation: Invitation }) {
  const [resend, resendAction, sending] = useActionState(resendInvitationAction.bind(null, invitation.id), { error: null, success: null });
  const [revoke, revokeAction, revoking] = useActionState(revokeInvitationAction.bind(null, invitation.id), { error: null, success: null });
  const busy = sending || revoking;
  return <div className="mt-3 space-y-2">
    <div className="flex flex-wrap gap-3">
      {["PENDING", "ACCEPTED", "ONBOARDING", "EXPIRED"].includes(invitation.status) && <form action={resendAction}><button disabled={busy} className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60">{sending ? "Sending…" : "Resend invitation"}</button></form>}
      {!["REVOKED", "COMPLETED"].includes(invitation.status) && <form action={revokeAction}><button disabled={busy} className="rounded-md border border-danger px-3 py-2 text-sm text-danger disabled:opacity-60">{revoking ? "Revoking…" : "Revoke invitation"}</button></form>}
    </div>
    <div aria-live="polite" className="text-sm">{(resend.error || revoke.error) && <p role="alert" className="text-danger">{resend.error || revoke.error}</p>}{(resend.success || revoke.success) && <p role="status" className="text-success">{resend.success || revoke.success}</p>}</div>
  </div>;
}
export function OnboardingForm({ step, fullName = "" }: { step: "password" | "profile"; fullName?: string }) {
  const action = step === "password" ? setOnboardingPassword : completeOnboarding;
  const [state, formAction, pending] = useActionState<InvitationFormState, FormData>(action, { error: null, success: null });
  return <form action={formAction} className="mt-6 space-y-5" aria-busy={pending}>
    <fieldset disabled={pending} className="space-y-5">
      {step === "password" ? <>
        <label className="block text-sm font-medium">New password<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={72} className={input} /></label>
        <label className="block text-sm font-medium">Confirm password<input name="confirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={72} className={input} /></label>
        <p className="text-xs text-text-secondary">Use at least 12 characters, up to 72 UTF-8 bytes.</p>
      </> : <label className="block text-sm font-medium">Full name<input name="fullName" required maxLength={200} defaultValue={fullName} autoComplete="name" className={input} /></label>}
      <button disabled={pending} className="w-full rounded-md bg-primary px-4 py-2 font-medium text-white hover:bg-primary-hover disabled:opacity-60">{pending ? "Saving…" : step === "password" ? "Save password and continue" : "Complete onboarding"}</button>
    </fieldset>
    <div aria-live="polite">{state.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}</div>
  </form>;
}
