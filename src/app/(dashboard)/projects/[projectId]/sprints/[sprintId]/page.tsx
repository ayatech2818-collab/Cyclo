import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, KanbanSquare, Target } from "lucide-react";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectLoadError } from "@/features/projects/components/project-header";
import { card, primaryButton } from "@/features/projects/components/styles";
import { formatProjectDate } from "@/features/projects/format";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { getProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { buildBurndown } from "@/features/sprints/burndown";
import { BurndownChart } from "@/features/sprints/components/burndown-chart";
import { CapacityEditor, EditSprintForm } from "@/features/sprints/components/sprint-forms";
import { DeveloperProgress, ProgressSummary } from "@/features/sprints/components/sprint-progress";
import { getSprintBurndown, getSprintProgress } from "@/features/sprints/execution.server";
import { CapacityMeter, SprintDates, SprintStatusBadge } from "@/features/sprints/components/sprint-parts";
import { BacklogPicker, SprintItemsTable, SprintLifecycle } from "@/features/sprints/components/sprint-planning";
import { capacityState, formatPoints, isOpenSprint, startBlocker } from "@/features/sprints/logic";
import { getSprint, getSprintCapacity, listSprintItems, listSprints } from "@/features/sprints/queries.server";
import { isWorkManager } from "@/features/work-items/validation";
import { cn } from "@/lib/utils/cn";

// Same title for every sprint and for missing ones: existence is not disclosed.
export const metadata: Metadata = { title: "Sprint | CYCLO" };

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-sm">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

export default async function SprintPage({ params }: { params: Promise<{ projectId: string; sprintId: string }> }) {
  const { profile } = await requireActiveProfile();
  const { projectId, sprintId } = await params;
  if (!isUuid(projectId) || !isUuid(sprintId)) notFound();

  const result = await loadProjectForPage(async () => {
    const [project, sprint, items, capacity, open, progress, burndown] = await Promise.all([
      getProject(projectId), getSprint(sprintId), listSprintItems(sprintId), getSprintCapacity(sprintId), listSprints(projectId, "open", 1, 100),
      getSprintProgress(sprintId), getSprintBurndown(sprintId),
    ]);
    return { project, sprint, items, capacity, open, progress, burndown };
  });
  if (result.error) return <ProjectLoadError code={result.error} retryHref={`/projects/${projectId}/sprints/${sprintId}`} />;
  const { project, sprint, items, capacity, open, progress, burndown: burndownRows } = result.data;
  if (!project || !sprint || sprint.projectId !== project.id) notFound();

  const canPlan = !project.archivedAt && isWorkManager(profile, project);
  const editable = canPlan && isOpenSprint(sprint.status);
  const otherOpen = open.sprints.filter((other) => other.id !== sprint.id).map((other) => ({ id: other.id, name: other.name, status: other.status as "PLANNING" | "ACTIVE" }));
  const hasActive = open.sprints.some((other) => other.status === "ACTIVE" && other.id !== sprint.id);
  // Exact from the item list; beyond one page, fall back to the sprint totals (the database decides on completion).
  const unfinished = items.total <= items.items.length
    ? items.items.filter((item) => item.status !== "DONE" && item.status !== "CANCELLED").length
    : sprint.itemCount - sprint.doneCount;
  const state = capacityState(sprint.estimateTotal, sprint.capacity);
  const donePercent = sprint.itemCount ? Math.round((sprint.doneCount / sprint.itemCount) * 100) : 0;
  const started = sprint.status !== "PLANNING" && sprint.startedAt !== null;
  const burndown = started ? buildBurndown(sprint.startDate, sprint.endDate, burndownRows) : null;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <Link href={`/projects/${projectId}/sprints`} className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary">
        <ArrowLeft aria-hidden="true" className="size-4" />{project.name} · Sprints
      </Link>

      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2"><SprintStatusBadge status={sprint.status} /><SprintDates sprint={sprint} /></div>
          <h1 className="text-2xl font-semibold tracking-tight break-words sm:text-3xl">{sprint.name}</h1>
          {sprint.goal && <p className="flex max-w-3xl gap-2 text-sm text-text-secondary"><Target aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-muted" />{sprint.goal}</p>}
          <p className="text-xs text-text-muted">
            Created {formatProjectDate(sprint.createdAt)}{sprint.createdByName ? ` by ${sprint.createdByName}` : ""}
            {sprint.startedAt && ` · started ${formatProjectDate(sprint.startedAt)}`}
            {sprint.completedAt && ` · completed ${formatProjectDate(sprint.completedAt)}`}
            {sprint.cancelledAt && ` · cancelled ${formatProjectDate(sprint.cancelledAt)}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {started && (
            <Link href={`/projects/${projectId}/sprints/${sprint.id}/board`} className={cn(primaryButton, "h-9")}>
              <KanbanSquare aria-hidden="true" className="size-4" />{sprint.status === "ACTIVE" ? "Open board" : "View board"}
            </Link>
          )}
          {editable && <EditSprintForm projectId={projectId} sprint={sprint} />}
        </div>
      </header>

      <section aria-label="Sprint summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Work items" value={String(sprint.itemCount)} hint={sprint.unestimatedCount ? `${sprint.unestimatedCount} not estimated` : "All estimated"} />
        <Tile label="Planned points" value={formatPoints(sprint.estimateTotal)} hint={sprint.capacity === null ? "No capacity set" : `Capacity ${formatPoints(sprint.capacity)}`} />
        <Tile label="Done" value={`${sprint.doneCount} / ${sprint.itemCount}`} hint={`${donePercent}% · ${formatPoints(sprint.doneEstimate)} pts`} />
        <Tile label="Unfinished" value={String(unfinished)} hint={sprint.status === "ACTIVE" ? "Handled when completing" : undefined} />
      </section>

      {state.kind === "over" && isOpenSprint(sprint.status) && (
        <p role="status" className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          Planned work ({formatPoints(state.planned)} pts) exceeds capacity ({formatPoints(state.capacity)} pts) by {formatPoints(state.overBy)} points. You can still plan it; consider rebalancing.
        </p>
      )}

      {started && burndown && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section className={cn(card, "min-w-0 p-5")} aria-labelledby="sprint-burndown">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="sprint-burndown" className="text-base font-semibold">Burndown</h2>
              <p className="text-xs text-text-muted">Story points · recorded from sprint history</p>
            </div>
            {burndown.points.length === 0 ? (
              <p className="text-sm text-text-muted">Set start and end dates to see the burndown.</p>
            ) : burndown.latest === null ? (
              <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-text-muted">
                No history has been recorded for this sprint yet. The chart fills in as the sprint runs; missing days are never shown as zero.
              </p>
            ) : (
              <>
                <BurndownChart burndown={burndown} />
                {(burndown.scopeChanged || burndown.missingDays > 0) && (
                  <p className="mt-3 text-xs text-text-muted">
                    {burndown.scopeChanged && "Scope changed during the sprint (work added, removed or re-estimated); the ideal line keeps the starting scope. "}
                    {burndown.missingDays > 0 && `${burndown.missingDays} day${burndown.missingDays === 1 ? " has" : "s have"} no recorded history.`}
                  </p>
                )}
              </>
            )}
          </section>
          <section className={cn(card, "p-5")} aria-labelledby="sprint-progress">
            <h2 id="sprint-progress" className="mb-3 text-sm font-semibold text-text-secondary">Progress</h2>
            <ProgressSummary progress={progress} />
          </section>
        </div>
      )}

      {started && (
        <section className={cn(card, "overflow-hidden")} aria-labelledby="sprint-developers">
          <div className="border-b border-border px-5 py-3.5"><h2 id="sprint-developers" className="text-base font-semibold">Progress by developer</h2></div>
          <DeveloperProgress progress={progress} viewerId={profile.id} />
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <section className={cn(card, "overflow-hidden")} aria-labelledby="sprint-items">
            <div className="border-b border-border px-5 py-3.5"><h2 id="sprint-items" className="text-base font-semibold">Planned work <span className="ml-1 text-xs font-medium text-text-secondary tabular-nums">{items.total}</span></h2></div>
            <SprintItemsTable projectId={projectId} sprintId={sprint.id} items={items.items} canEdit={editable} moveTargets={otherOpen} />
          </section>

          {editable && (
            <section className={cn(card, "overflow-hidden")} aria-labelledby="sprint-backlog">
              <div className="border-b border-border px-5 py-3.5">
                <h2 id="sprint-backlog" className="text-base font-semibold">Add from backlog</h2>
                <p className="mt-0.5 text-xs text-text-secondary">Open stories, tasks and bugs that are not in a sprint. Adding keeps their status.</p>
              </div>
              <BacklogPicker projectId={projectId} sprintId={sprint.id} />
            </section>
          )}
        </div>

        <aside className="space-y-6">
          {editable && (
            <section className={cn(card, "space-y-3 p-5")} aria-labelledby="sprint-lifecycle">
              <h2 id="sprint-lifecycle" className="text-sm font-semibold text-text-secondary">Lifecycle</h2>
              {/* Keyed on status: each lifecycle step resets the panel to the actions of the new state. */}
              <SprintLifecycle key={sprint.status} projectId={projectId} sprintId={sprint.id} status={sprint.status as "PLANNING" | "ACTIVE"}
                startBlocker={startBlocker(sprint, hasActive)} unfinishedCount={unfinished} carryTargets={otherOpen} />
            </section>
          )}

          <section className={cn(card, "space-y-4 p-5")} aria-labelledby="sprint-capacity">
            <h2 id="sprint-capacity" className="text-sm font-semibold text-text-secondary">Capacity</h2>
            <CapacityMeter planned={sprint.estimateTotal} capacity={sprint.capacity} />
            {editable && <CapacityEditor key={String(sprint.capacity)} projectId={projectId} sprintId={sprint.id} capacity={sprint.capacity} />}
            <div>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-text-muted uppercase">By developer</h3>
              {capacity.length === 0 ? <p className="text-xs text-text-muted">No planned work yet.</p> : (
                <ul className="divide-y divide-border text-sm">
                  {capacity.map((row) => (
                    <li key={row.assigneeId ?? "unassigned"} className="flex items-center justify-between gap-3 py-2">
                      <span className={cn("min-w-0 truncate", !row.assigneeId && "text-text-muted")}>{row.assigneeName ?? "Unassigned"}</span>
                      <span className="shrink-0 text-xs text-text-secondary tabular-nums">
                        {row.itemCount} item{row.itemCount === 1 ? "" : "s"} · <span className="font-semibold text-text-primary">{formatPoints(row.estimate)}</span> pts
                        {row.unestimated > 0 && <span className="text-warning"> · {row.unestimated} ?</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
