import Link from "next/link";
import { AlertTriangle, Archive, ArrowLeft, Pencil, UserRound } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { secondaryButton as panelButton } from "@/components/ui/styles";
import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { cn } from "@/lib/utils/cn";

import { PROJECT_ERROR_MESSAGES } from "../errors";
import type { PageErrorCode } from "../page-errors.server";
import { formatProjectDate, managerLabel } from "../format";
import { projectSchedule } from "../schedule";
import type { ProjectDetail } from "../types";
import { ArchivedBadge, ProjectPriorityBadge, ProjectStatusBadge } from "./project-badges";
import { ProjectKeyTile, ScheduleBar } from "./project-visuals";
import { secondaryButton } from "./styles";

/** Project sections. Navigation between them lives in the sidebar (Phase 8H Part 2). */
export type ProjectSection = "overview" | "team" | "work" | "backlog" | "sprints" | "activity";

const SECTION_LABELS: Record<ProjectSection, string> = {
  overview: "Overview",
  team: "Team",
  work: "Work",
  backlog: "Backlog",
  sprints: "Sprints",
  activity: "Activity",
};

/**
 * Title block and archived notice shared by every project section. The
 * overview shows the full project summary; other sections a compact title.
 */
export function ProjectHeader({ project, canManage, current }: { project: ProjectDetail; canManage: boolean; current: ProjectSection }) {
  const archived = Boolean(project.archivedAt);
  const notice = archived && (
    <div role="status" className="flex items-start gap-3 rounded-xl border border-border bg-surface-muted px-4 py-3 text-sm">
      <Archive aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-secondary" />
      <p>
        Archived on <span className="font-medium">{formatProjectDate(project.archivedAt)}</span>. This project is read-only
        {canManage ? "; restore it to make changes." : "."}
      </p>
    </div>
  );

  if (current !== "overview") {
    return (
      <>
        <header className="flex items-center gap-3">
          <ProjectKeyTile projectKey={project.projectKey} size="md" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium tracking-wide text-text-muted uppercase">{SECTION_LABELS[current]}</p>
            <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">{project.name}</h1>
          </div>
          <div className="hidden shrink-0 flex-wrap items-center gap-1.5 sm:flex">
            <ProjectStatusBadge status={project.status} />
            {archived && <ArchivedBadge />}
          </div>
        </header>
        {notice}
      </>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <header className="relative overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div aria-hidden="true" className="h-1.5 bg-gradient-to-r from-primary via-primary to-accent" />
        <div className="flex flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 gap-4">
            <ProjectKeyTile projectKey={project.projectKey} size="lg" className="hidden sm:flex" />
            <div className="min-w-0 space-y-2.5">
              <p className="font-mono text-xs font-medium text-text-muted">{project.projectKey}</p>
              <h1 className="text-2xl font-semibold tracking-tight break-words sm:text-3xl">{project.name}</h1>
              <div className="flex flex-wrap items-center gap-1.5">
                <ProjectStatusBadge status={project.status} />
                <ProjectPriorityBadge priority={project.priority} />
                {archived && <ArchivedBadge />}
              </div>
              {project.description ? (
                <p className="max-w-3xl text-sm leading-relaxed whitespace-pre-line text-text-secondary">{project.description}</p>
              ) : (
                <p className="text-sm text-text-muted">No description has been added yet.</p>
              )}
            </div>
          </div>
          {canManage && !archived && (
            <Link href={`/projects/${project.id}/edit`} className={cn(secondaryButton, "self-start")}>
              <Pencil aria-hidden="true" className="size-4" />
              Edit project
            </Link>
          )}
        </div>
        <div className="grid gap-4 border-t border-border bg-surface-muted/40 px-5 py-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <EmployeeAvatar fullName={project.projectManagerName} email={null} avatarUrl={null} size="sm" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{managerLabel(project.projectManagerName)}</p>
              <p className="text-xs text-text-muted">Project Manager</p>
            </div>
          </div>
          <ScheduleBar schedule={projectSchedule(project, today)} startDate={project.startDate} targetDate={project.targetDate} className="self-center" />
        </div>
      </header>
      {notice}
    </>
  );
}

/** The assigned Project Manager: name, email and an inactive warning. */
export function ProjectManagerIdentity({ project, canAssign }: { project: ProjectDetail; canAssign: boolean }) {
  return (
    <>
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UserRound aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{managerLabel(project.projectManagerName)}</p>
          {project.projectManagerEmail && <p className="truncate text-xs text-text-secondary">{project.projectManagerEmail}</p>}
        </div>
      </div>
      {!project.projectManagerIsActive && (
        <p className="mt-3 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
          This Project Manager is no longer active.{canAssign ? " Assign an active Project Manager." : " A Super Admin must reassign the project."}
        </p>
      )}
    </>
  );
}

/** Inline error state for a project page whose data could not be loaded. */
export function ProjectLoadError({ code, retryHref }: { code: PageErrorCode; retryHref: string }) {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <Link href="/projects" className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary">
        <ArrowLeft aria-hidden="true" className="size-4" />
        Projects
      </Link>
      <EmptyState
        tone="danger"
        icon={AlertTriangle}
        title="Couldn’t load this project"
        description={PROJECT_ERROR_MESSAGES[code]}
        action={<Link href={retryHref} className={panelButton}>Try again</Link>}
      />
    </main>
  );
}
