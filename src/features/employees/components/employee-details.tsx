import type { ReactNode } from "react";

import { displayName, formatDateTime } from "../format";
import type { ResolvedAvatar } from "@/features/profile/avatar";

import type { EmployeeAdminDetail, EmployeeDirectoryItem } from "../types";
import { EmployeeAvatar } from "./employee-avatar";
import { EmployeeStatusBadge, RoleBadge } from "./employee-badges";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-3 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm text-text-secondary">{label}</dt>
      <dd className="mt-1 text-sm font-medium break-words sm:col-span-2 sm:mt-0">{children}</dd>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="font-normal text-text-secondary">{children}</span>;
}

function DateValue({ iso, fallback }: { iso: string | null; fallback: string }) {
  const text = formatDateTime(iso);
  return text && iso ? <time dateTime={iso}>{text}</time> : <Muted>{fallback}</Muted>;
}

function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-border bg-surface p-5 shadow-sm sm:p-6">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-1 text-xs text-text-secondary">{description}</p>}
      <dl className="mt-2 divide-y divide-border">{children}</dl>
    </section>
  );
}

export function EmployeeHeader({ employee, isSelf, avatar }: { employee: EmployeeDirectoryItem; isSelf: boolean; avatar?: ResolvedAvatar | null }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <EmployeeAvatar fullName={employee.fullName} email={employee.email} avatarUrl={employee.avatarUrl} avatar={avatar} size="lg" />
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight">
          {displayName(employee.fullName, employee.email)}
          {isSelf && <span className="ml-2 align-middle text-sm font-medium text-text-secondary">(you)</span>}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <RoleBadge role={employee.role} />
          <EmployeeStatusBadge isActive={employee.isActive} />
        </div>
      </div>
    </div>
  );
}

/** Fields every directory viewer (Super Admin, Project Manager) may see. */
export function EmployeeDirectoryFields({ employee }: { employee: EmployeeDirectoryItem }) {
  return (
    <Card title="Employee information">
      <Field label="Full name">{employee.fullName?.trim() || <Muted>Not set</Muted>}</Field>
      <Field label="Email">{employee.email ?? <Muted>Not available</Muted>}</Field>
      <Field label="Employee code">
        {employee.employeeCode ? <span className="font-mono">{employee.employeeCode}</span> : <Muted>Not assigned</Muted>}
      </Field>
      <Field label="Role"><RoleBadge role={employee.role} /></Field>
      <Field label="Account status"><EmployeeStatusBadge isActive={employee.isActive} /></Field>
    </Card>
  );
}

/** Super Admin only. Rendered exclusively from an EmployeeAdminDetail DTO. */
export function EmployeeAdminFields({ employee }: { employee: EmployeeAdminDetail }) {
  return (
    <Card title="Administration" description="Visible to Super Admins only.">
      <Field label="Git Organizer">{employee.isGitOrganizer ? "Granted" : <Muted>Not granted</Muted>}</Field>
      <Field label="Invited by">{employee.invitedByName ?? <Muted>{employee.invitedBy ? "Former employee" : "Not recorded"}</Muted>}</Field>
      <Field label="Onboarding">
        <DateValue iso={employee.onboardedAt} fallback="Not completed" />
      </Field>
      <Field label="Created"><DateValue iso={employee.createdAt} fallback="Unknown" /></Field>
      <Field label="Last updated"><DateValue iso={employee.updatedAt} fallback="Unknown" /></Field>
    </Card>
  );
}
