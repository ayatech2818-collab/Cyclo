import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectHeader, ProjectLoadError } from "@/features/projects/components/project-header";
import { DetailsCard, OverviewStats, RecentActivity, SprintCard, TeamCard, WorkBreakdown } from "@/features/projects/components/project-overview";
import { ArchiveControl, AssignManagerForm } from "@/features/projects/components/project-manage";
import { card } from "@/features/projects/components/styles";
import { loadProjectOverview } from "@/features/projects/overview.server";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { getProject, listProjectManagerOptions } from "@/features/projects/queries.server";
import { canAssignProjectManager, canManageProject, isUuid } from "@/features/projects/validation";
import { cn } from "@/lib/utils/cn";

// Same title for every project and for missing ones: existence is not disclosed.
export const metadata: Metadata = { title: "Project | CYCLO" };

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
  const today = new Date().toISOString().slice(0, 10);
  // Decorative for the reassign form; a failure leaves the form disabled.
  const [managerOptions, overview] = await Promise.all([
    canAssign ? listProjectManagerOptions().catch(() => null) : Promise.resolve(null),
    loadProjectOverview(project.id),
  ]);

  return (
    <main className="mx-auto w-full max-w-[88rem] space-y-6 px-4 py-6 sm:px-6 lg:py-8">
      <ProjectHeader project={project} canManage={canManage} current="overview" />
      <OverviewStats project={project} data={overview} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <div className="grid gap-6 2xl:grid-cols-2">
            <SprintCard project={project} data={overview} today={today} />
            <WorkBreakdown project={project} data={overview} />
          </div>
          <RecentActivity project={project} data={overview} />
        </div>

        <aside className="grid content-start gap-6 md:grid-cols-2 lg:grid-cols-1" aria-label="Project information">
          <TeamCard project={project} data={overview}>
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
          </TeamCard>
          <DetailsCard project={project} />

          {canManage && (
            <section className={cn(card, "p-5")} aria-labelledby="project-lifecycle">
              <h2 id="project-lifecycle" className="text-[15px] font-semibold">{archived ? "Restore project" : "Archive project"}</h2>
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
