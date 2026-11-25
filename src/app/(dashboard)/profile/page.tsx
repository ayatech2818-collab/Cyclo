import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { EmployeeStatusBadge, RoleBadge } from "@/features/employees/components/employee-badges";
import { StatePanel } from "@/features/employees/components/state-panel";
import { EMPLOYEE_ERROR_MESSAGES } from "@/features/employees/errors";
import { displayName, safeAvatarUrl } from "@/features/employees/format";
import { loadForPage } from "@/features/employees/page-errors.server";
import { getMyProfile } from "@/features/employees/queries.server";
import { getMyAvatarDetails } from "@/features/profile/avatars.server";
import { AvatarPicker, ProfileNameForm } from "@/features/profile/components/profile-forms";

export const metadata: Metadata = { title: "Your profile | CYCLO" };

function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-border bg-surface p-5 shadow-sm sm:p-6">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-1 text-xs text-text-secondary">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ReadOnly({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-3 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm text-text-secondary">{label}</dt>
      <dd className="mt-1 text-sm font-medium break-words sm:col-span-2 sm:mt-0">{children}</dd>
    </div>
  );
}

/** Every active employee: own profile only. Role, status, code and Git Organizer are read-only here. */
export default async function ProfilePage() {
  const result = await loadForPage(async () => ({ profile: await getMyProfile(), avatar: await getMyAvatarDetails() }));

  if (result.error) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <StatePanel tone="danger" icon={AlertTriangle} title="Couldn’t load your profile" description={EMPLOYEE_ERROR_MESSAGES[result.error]} />
      </main>
    );
  }

  const { profile, avatar } = result.data;
  const muted = (text: string) => <span className="font-normal text-text-secondary">{text}</span>;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <EmployeeAvatar fullName={profile.fullName} email={profile.email} avatarUrl={null} avatar={avatar.resolved} size="xl" />
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{displayName(profile.fullName, profile.email)}</h1>
          <p className="truncate text-sm text-text-secondary">{profile.email}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <RoleBadge role={profile.role} />
            <EmployeeStatusBadge isActive={profile.isActive} />
          </div>
        </div>
      </div>

      <Card title="Avatar" description="Choose a photo, an emoji, an icon or your initials. Your choice appears across CYCLO.">
        <AvatarPicker
          fullName={profile.fullName}
          email={profile.email}
          kind={avatar.state?.kind ?? "default"}
          symbol={avatar.state?.symbol ?? null}
          photoSrc={avatar.photoSrc}
          hasPhoto={Boolean(avatar.state?.path)}
          adminUrl={safeAvatarUrl(profile.avatarUrl)}
        />
      </Card>

      <Card title="Personal information">
        <ProfileNameForm fullName={profile.fullName ?? ""} />
      </Card>

      <Card title="Account" description="Managed by your administrators. Contact a Super Admin to change these.">
        <dl className="divide-y divide-border">
          <ReadOnly label="Email">{profile.email ?? muted("Not available")}</ReadOnly>
          <ReadOnly label="Employee code">{profile.employeeCode ? <span className="font-mono text-xs">{profile.employeeCode}</span> : muted("Not assigned")}</ReadOnly>
          <ReadOnly label="Role"><RoleBadge role={profile.role} /></ReadOnly>
          <ReadOnly label="Git Organizer">{profile.isGitOrganizer ? "Yes" : muted("No")}</ReadOnly>
        </dl>
      </Card>
    </main>
  );
}
