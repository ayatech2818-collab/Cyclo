import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireActiveProfile } from "@/features/auth/server";
import { ActivityFeed } from "@/features/projects/components/project-activity";
import { ProjectHeader, ProjectLoadError } from "@/features/projects/components/project-header";
import { card } from "@/features/projects/components/styles";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { getProject, listProjectActivity } from "@/features/projects/queries.server";
import { canManageProject, isUuid } from "@/features/projects/validation";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Project activity | CYCLO" };

export default async function ProjectActivityPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { profile } = await requireActiveProfile();
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();

  // Both RPCs enforce visibility (SA, assigned PM, member developer); otherwise 404.
  const result = await loadProjectForPage(async () => {
    const [project, activity] = await Promise.all([getProject(projectId), listProjectActivity(projectId)]);
    return { project, activity };
  });
  if (result.error) return <ProjectLoadError code={result.error} retryHref={`/projects/${projectId}/activity`} />;

  const { project, activity } = result.data;
  if (!project) notFound();

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <ProjectHeader project={project} canManage={canManageProject(profile, project)} current="activity" />

      <section className={cn(card, "mx-auto max-w-3xl overflow-hidden")} aria-labelledby="project-activity">
        <div className="border-b border-border px-5 py-4 sm:px-6">
          <h2 id="project-activity" className="text-base font-semibold">Activity</h2>
          <p className="mt-0.5 text-sm text-text-secondary">Changes to this project and its team, newest first.</p>
        </div>
        <ActivityFeed projectId={project.id} initialEntries={activity.entries} initialCursor={activity.nextCursor} />
      </section>
    </main>
  );
}
