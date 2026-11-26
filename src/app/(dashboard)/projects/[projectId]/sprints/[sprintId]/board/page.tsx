import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarClock, Lock } from "lucide-react";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectLoadError } from "@/features/projects/components/project-header";
import { card, secondaryButton } from "@/features/projects/components/styles";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { getProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { SprintBoard } from "@/features/sprints/components/sprint-board";
import { SprintDates, SprintStatusBadge } from "@/features/sprints/components/sprint-parts";
import { getSprintProgress, listSprintBoard } from "@/features/sprints/execution.server";
import { getSprint } from "@/features/sprints/queries.server";
import { isWorkManager } from "@/features/work-items/validation";
import { cn } from "@/lib/utils/cn";

// Same title for every sprint and for missing ones: existence is not disclosed.
export const metadata: Metadata = { title: "Sprint board | CYCLO" };

export default async function SprintBoardPage({ params }: { params: Promise<{ projectId: string; sprintId: string }> }) {
  const { profile } = await requireActiveProfile();
  const { projectId, sprintId } = await params;
  if (!isUuid(projectId) || !isUuid(sprintId)) notFound();

  const result = await loadProjectForPage(async () => {
    const [project, sprint] = await Promise.all([getProject(projectId), getSprint(sprintId)]);
    if (!project || !sprint || sprint.projectId !== project.id || sprint.status === "PLANNING") return { project, sprint, items: [], progress: null };
    const [items, progress] = await Promise.all([listSprintBoard(sprintId), getSprintProgress(sprintId)]);
    return { project, sprint, items, progress };
  });
  if (result.error) return <ProjectLoadError code={result.error} retryHref={`/projects/${projectId}/sprints/${sprintId}/board`} />;
  const { project, sprint, items, progress } = result.data;
  if (!project || !sprint || sprint.projectId !== project.id) notFound();

  const sprintHref = `/projects/${projectId}/sprints/${sprint.id}`;
  const executable = sprint.status === "ACTIVE" && !project.archivedAt;
  const viewer = { id: profile.id, isManager: isWorkManager(profile, project), writable: executable };

  return (
    <main className="mx-auto w-full max-w-[96rem] space-y-6 px-4 py-8 sm:px-6">
      <Link href={sprintHref} className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary">
        <ArrowLeft aria-hidden="true" className="size-4" />{project.name} · {sprint.name}
      </Link>

      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2"><SprintStatusBadge status={sprint.status} /><SprintDates sprint={sprint} /></div>
          <h1 className="text-2xl font-semibold tracking-tight break-words sm:text-3xl">{sprint.name} board</h1>
        </div>
        <Link href={sprintHref} className={cn(secondaryButton, "h-9 shrink-0")}>Sprint overview &amp; burndown</Link>
      </header>

      {sprint.status === "PLANNING" ? (
        <section className={cn(card, "flex flex-col items-start gap-3 p-6")}>
          <CalendarClock aria-hidden="true" className="size-6 text-text-muted" />
          <h2 className="font-semibold">This sprint has not started</h2>
          <p className="max-w-xl text-sm text-text-secondary">The board opens when the sprint starts. Until then, plan its work on the sprint page.</p>
          <Link href={sprintHref} className={cn(secondaryButton, "h-9")}>Go to sprint planning</Link>
        </section>
      ) : (
        <>
          {!executable && (
            <p role="status" className="flex items-start gap-2 rounded-lg border border-border bg-surface-muted px-4 py-3 text-sm text-text-secondary">
              <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {project.archivedAt ? "This project is archived. The board is read-only."
                : sprint.status === "COMPLETED" ? "This sprint is completed. The board is read-only and shows where the work ended."
                  : "This sprint was cancelled. The board is read-only."}
            </p>
          )}
          {items.length >= 500 && <p className="text-xs text-warning">Showing the first 500 items of this sprint.</p>}
          <SprintBoard projectId={projectId} sprintId={sprint.id} items={items} progress={progress} viewer={viewer} />
        </>
      )}
    </main>
  );
}
