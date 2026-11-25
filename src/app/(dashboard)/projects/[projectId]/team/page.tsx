import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Users } from "lucide-react";

import { requireActiveProfile } from "@/features/auth/server";
import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { ProjectHeader, ProjectLoadError, ProjectManagerIdentity } from "@/features/projects/components/project-header";
import { AddDeveloperPicker, RemoveMemberButton } from "@/features/projects/components/project-team";
import { card } from "@/features/projects/components/styles";
import { formatProjectDate } from "@/features/projects/format";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { getProject, listProjectMembers } from "@/features/projects/queries.server";
import { canAssignProjectManager, canManageProject, isUuid } from "@/features/projects/validation";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Project team | CYCLO" };

export default async function ProjectTeamPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { profile } = await requireActiveProfile();
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();

  // Both RPCs enforce visibility; a project the caller cannot see is a 404.
  const result = await loadProjectForPage(async () => {
    const [project, members] = await Promise.all([getProject(projectId), listProjectMembers(projectId)]);
    return { project, members };
  });
  if (result.error) return <ProjectLoadError code={result.error} retryHref={`/projects/${projectId}/team`} />;

  const { project, members } = result.data;
  if (!project) notFound();

  const canManage = canManageProject(profile, project);
  const archived = Boolean(project.archivedAt);
  const canEditTeam = canManage && !archived;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <ProjectHeader project={project} canManage={canManage} current="team" />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className={cn(card, "overflow-hidden")} aria-labelledby="team-developers">
          <div className="flex flex-col gap-4 border-b border-border p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
            <div>
              <h2 id="team-developers" className="text-base font-semibold">
                Developers <span className="ml-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-text-secondary">{members.length}</span>
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                {canEditTeam
                  ? "Developers on this team can see the project."
                  : archived
                    ? "Archived projects are read-only. Restore the project to change its team."
                    : "Members of this project."}
              </p>
            </div>
            {canEditTeam && <AddDeveloperPicker projectId={project.id} />}
          </div>

          {members.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-14 text-center">
              <span className="mb-4 rounded-full bg-primary/10 p-3 text-primary">
                <Users aria-hidden="true" className="size-6" />
              </span>
              <p className="text-base font-semibold">No developers yet</p>
              <p className="mt-1 max-w-sm text-sm text-text-secondary">
                {canEditTeam ? "Add developers to give them access to this project." : "Developers added to this project will appear here."}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {members.map((member) => {
                const name = member.fullName?.trim() || member.email || "Unnamed developer";
                const isSelf = member.profileId === profile.id;
                return (
                  <li key={member.membershipId} className="flex items-center gap-3 px-5 py-3.5 sm:px-6">
                    <EmployeeAvatar fullName={member.fullName} email={member.email} avatarUrl={null} size="md" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="truncate">{name}</span>
                        {isSelf && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">You</span>}
                        {!member.isActive && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">Inactive</span>}
                      </p>
                      <p className="truncate text-xs text-text-secondary">
                        {member.email && member.fullName ? `${member.email} · ` : ""}Added {formatProjectDate(member.addedAt)}
                        {member.addedByName ? ` by ${member.addedByName}` : ""}
                      </p>
                    </div>
                    {canEditTeam && <RemoveMemberButton projectId={project.id} profileId={member.profileId} name={name} />}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside>
          <section className={cn(card, "p-5")} aria-labelledby="team-manager">
            <h2 id="team-manager" className="text-sm font-semibold text-text-secondary">Project Manager</h2>
            <p className="mt-0.5 mb-3 text-xs text-text-muted">Leads the project and manages its team.</p>
            <ProjectManagerIdentity project={project} canAssign={canAssignProjectManager(profile.role)} />
          </section>
        </aside>
      </div>
    </main>
  );
}
