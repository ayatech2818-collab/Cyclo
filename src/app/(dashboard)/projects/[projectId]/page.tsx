import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectHeader, ProjectLoadError, ProjectManagerIdentity } from "@/features/projects/components/project-header";
import { ArchiveControl, AssignManagerForm } from "@/features/projects/components/project-manage";
import { card } from "@/features/projects/components/styles";
import { formatProjectDate } from "@/features/projects/format";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { getProject, listProjectManagerOptions } from "@/features/projects/queries.server";
import { canAssignProjectManager, canManageProject, isUuid } from "@/features/projects/validation";
import { cn } from "@/lib/utils/cn";

// Same title for every project and for missing ones: existence is not disclosed.
export const metadata: Metadata = { title: "Project | CYCLO" };

function DetailRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-3 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="w-32 shrink-0 text-sm text-text-secondary">{term}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

export default async function ProjectDetailPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { profile } = await requireActiveProfile();
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();

  const result = await loadProjectForPage(() => getProject(projectId));
  if (result.error) return <ProjectLoadError code={result.error} retryHref={`/projects/${projectId}`} />;

  const project = result.data;
  if (!project) notFound();

  const canManage = canManageProject(profile, project);
  const canAssign = canAssignProjectManager(profile.role);
  const archived = Boolean(project.archivedAt);
  // Decorative for the reassign form; a failure leaves the form disabled.
  const managerOptions = canAssign ? await listProjectManagerOptions().catch(() => null) : null;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <ProjectHeader project={project} canManage={canManage} current="overview" />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <section className={cn(card, "p-5 sm:p-6")} aria-labelledby="project-about">
            <h2 id="project-about" className="text-base font-semibold">About</h2>
            {project.description ? (
              <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-text-secondary">{project.description}</p>
            ) : (
              <p className="mt-3 text-sm text-text-muted">No description has been added yet.</p>
            )}
          </section>

          <section className={cn(card, "p-5 sm:p-6")} aria-labelledby="project-details">
            <h2 id="project-details" className="text-base font-semibold">Details</h2>
            <dl className="mt-2 divide-y divide-border">
              <DetailRow term="Start date">{formatProjectDate(project.startDate) ?? <span className="font-normal text-text-muted">Not set</span>}</DetailRow>
              <DetailRow term="Target date">{formatProjectDate(project.targetDate) ?? <span className="font-normal text-text-muted">Not set</span>}</DetailRow>
              <DetailRow term="Created">
                {formatProjectDate(project.createdAt)}
                {project.createdByName && <span className="font-normal text-text-secondary"> by {project.createdByName}</span>}
              </DetailRow>
              <DetailRow term="Last updated">{formatProjectDate(project.updatedAt)}</DetailRow>
            </dl>
          </section>
        </div>

        <aside className="space-y-6">
          <section className={cn(card, "p-5")} aria-labelledby="project-manager">
            <h2 id="project-manager" className="mb-3 text-sm font-semibold text-text-secondary">Project Manager</h2>
            <ProjectManagerIdentity project={project} canAssign={canAssign} />
            {canAssign && (
              <div className="mt-4 border-t border-border pt-4">
                {archived ? (
                  <p className="text-xs text-text-secondary">Restore the project to reassign its Project Manager.</p>
                ) : managerOptions ? (
                  <AssignManagerForm projectId={project.id} currentManagerId={project.projectManagerId} options={managerOptions} />
                ) : (
                  <p className="text-xs text-danger">Project Managers could not be loaded. Reload the page to try again.</p>
                )}
              </div>
            )}
          </section>

          {canManage && (
            <section className={cn(card, "p-5")} aria-labelledby="project-lifecycle">
              <h2 id="project-lifecycle" className="text-sm font-semibold text-text-secondary">{archived ? "Restore" : "Archive"}</h2>
              <p className="mt-1 mb-4 text-xs text-text-secondary">
                {archived ? "Make this project active and editable again." : "Projects are never deleted. Archive projects that are no longer in use."}
              </p>
              <ArchiveControl projectId={project.id} archived={archived} projectName={project.name} />
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
