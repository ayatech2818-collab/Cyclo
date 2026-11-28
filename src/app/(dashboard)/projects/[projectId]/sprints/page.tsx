import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarRange, History } from "lucide-react";

import { PagePagination } from "@/components/shared/page-pagination";
import { requireActiveProfile } from "@/features/auth/server";
import { EmptyState } from "@/components/ui/empty-state";
import { ProjectHeader, ProjectLoadError } from "@/features/projects/components/project-header";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { getProject } from "@/features/projects/queries.server";
import { canManageProject, isUuid } from "@/features/projects/validation";
import { CreateSprintPanel } from "@/features/sprints/components/sprint-forms";
import { SprintCard } from "@/features/sprints/components/sprint-parts";
import { HISTORY_PAGE_SIZE } from "@/features/sprints/logic";
import { listSprints } from "@/features/sprints/queries.server";
import { isWorkManager } from "@/features/work-items/validation";

export const metadata: Metadata = { title: "Sprints | CYCLO" };

export default async function ProjectSprintsPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { profile } = await requireActiveProfile();
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const pageParam = (await searchParams).page;
  const historyPage = typeof pageParam === "string" && /^\d{1,5}$/.test(pageParam) ? Math.max(1, Number(pageParam)) : 1;

  const result = await loadProjectForPage(async () => {
    const [project, open, closed] = await Promise.all([
      getProject(projectId),
      listSprints(projectId, "open", 1, 100),
      listSprints(projectId, "closed", historyPage, HISTORY_PAGE_SIZE),
    ]);
    return { project, open, closed };
  });
  if (result.error) return <ProjectLoadError code={result.error} retryHref={`/projects/${projectId}/sprints`} />;
  const { project, open, closed } = result.data;
  if (!project) notFound();

  const canPlan = !project.archivedAt && isWorkManager(profile, project);
  const active = open.sprints.find((sprint) => sprint.status === "ACTIVE") ?? null;
  const planning = open.sprints.filter((sprint) => sprint.status === "PLANNING");
  const allCount = open.total + closed.total;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <ProjectHeader project={project} canManage={canManageProject(profile, project)} current="sprints" />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-2xl text-sm text-text-secondary">
          Plan work into time-boxed sprints. One sprint can be active at a time; planned sprints can be prepared in advance.
        </p>
        {canPlan && <div className="sm:min-w-[28rem] sm:max-w-xl sm:text-right"><CreateSprintPanel projectId={projectId} suggestedName={`Sprint ${allCount + 1}`} /></div>}
      </div>

      {allCount === 0 ? (
        <EmptyState icon={CalendarRange} title="No sprints yet"
          description={canPlan ? "Create the first sprint, then add work from the backlog." : "Sprints planned for this project will appear here."} />
      ) : (
        <>
          <section aria-labelledby="sprints-active" className="space-y-3">
            <h2 id="sprints-active" className="text-xs font-semibold tracking-wide text-text-muted uppercase">Active</h2>
            {active ? <SprintCard projectId={projectId} sprint={active} highlight /> : (
              <p className="rounded-xl border border-dashed border-border px-4 py-5 text-sm text-text-secondary">No sprint is active.{canPlan && planning.length > 0 && " Open a planned sprint to start it."}</p>
            )}
          </section>

          <section aria-labelledby="sprints-planning" className="space-y-3">
            <h2 id="sprints-planning" className="text-xs font-semibold tracking-wide text-text-muted uppercase">Planning <span className="ml-1 tabular-nums">{planning.length}</span></h2>
            {planning.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {planning.map((sprint) => <SprintCard key={sprint.id} projectId={projectId} sprint={sprint} />)}
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-border px-4 py-5 text-sm text-text-secondary">No planned sprints.</p>
            )}
          </section>

          <section aria-labelledby="sprints-history" className="space-y-3">
            <h2 id="sprints-history" className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-text-muted uppercase">
              <History aria-hidden="true" className="size-3.5" />Completed &amp; cancelled <span className="ml-1 tabular-nums">{closed.total}</span>
            </h2>
            {closed.sprints.length > 0 ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {closed.sprints.map((sprint) => <SprintCard key={sprint.id} projectId={projectId} sprint={sprint} />)}
                </div>
                <PagePagination page={historyPage} pageSize={HISTORY_PAGE_SIZE} pageCount={closed.pageCount} total={closed.total}
                  noun={{ one: "sprint", many: "sprints" }} hrefFor={(page) => `/projects/${projectId}/sprints${page > 1 ? `?page=${page}` : ""}`} />
              </>
            ) : (
              <p className="rounded-xl border border-dashed border-border px-4 py-5 text-sm text-text-secondary">No finished sprints yet.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
