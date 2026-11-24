import Link from "next/link";
import { notFound } from "next/navigation";
import { requireActiveProfile } from "@/features/auth/server";
import { InviteEmployeeForm, InvitationControls } from "@/features/invitations/forms";
import { listInvitations } from "@/features/invitations/operations.server";
import { ROLE_LABELS } from "@/features/employees/types";
import { formatDateTime } from "@/features/employees/format";
import { InvitationError } from "@/features/invitations/errors";
export const metadata = { title: "Employee invitations | CYCLO" };
export default async function InvitationsPage() {
  const { profile } = await requireActiveProfile();
  if (profile.role !== "SUPER_ADMIN") notFound();
  let invitations;
  try { invitations = await listInvitations(); }
  catch (error) { if (error instanceof InvitationError) return <p role="alert" className="p-6 text-danger">{error.message}</p>; throw error; }
  return <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
    <Link href="/employees" className="text-sm text-primary">Back to employees</Link>
    <h1 className="text-2xl font-semibold">Employee invitations</h1>
    <InviteEmployeeForm />
    <section aria-label="Invitations" className="space-y-4">
      <h2 className="text-lg font-semibold">Recent invitations</h2>
      {!invitations.length && <p className="text-text-secondary">No invitations yet.</p>}
      {invitations.map(invitation => <article key={invitation.id} className="rounded-xl border border-border bg-surface p-5">
        <h3 className="font-semibold break-words">{invitation.fullName}</h3>
        <p className="break-all text-sm text-text-secondary">{invitation.email}</p>
        <p className="mt-2 text-sm">{ROLE_LABELS[invitation.role]} · {invitation.status}</p>
        <p className="mt-1 text-xs text-text-secondary">Expires {formatDateTime(invitation.expiresAt)}</p>
        {invitation.deliveryFailed && <p className="mt-2 text-sm text-danger">Email delivery failed. Check local Auth configuration and resend.</p>}
        {!invitation.lastSentAt && !invitation.deliveryFailed && invitation.status === "PENDING" && <p className="mt-2 text-sm text-text-secondary">Email delivery has not been confirmed. Use Resend if needed.</p>}
        <InvitationControls invitation={invitation} />
      </article>)}
    </section>
  </main>;
}
