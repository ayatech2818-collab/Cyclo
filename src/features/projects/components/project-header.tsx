import Link from "next/link";
import { AlertTriangle, Archive, ArrowLeft, Pencil, UserRound } from "lucide-react";

import { StatePanel, secondaryButton as panelButton } from "@/features/employees/components/state-panel";

import { cn } from "@/lib/utils/cn";

import { PROJECT_ERROR_MESSAGES } from "../errors";
import type { PageErrorCode } from "../page-errors.server";
import { formatProjectDate, managerLabel } from "../format";
import type { ProjectDetail } from "../types";
import { ArchivedBadge, ProjectKeyBadge, ProjectPriorityBadge, ProjectStatusBadge } from "./project-badges";
import { ProjectSectionNav, type ProjectSection } from "./project-section-nav";
import { secondaryButton } from "./styles";

/** Back link, title block, archived notice and section tabs shared by every project section. */
export function ProjectHeader({ project, canManage, current }: { project: ProjectDetail; canManage: boolean; current: ProjectSection }) {
  const archived = Boolean(project.archivedAt);
  return (
    <>
      <Link href="/projects" className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary">
        <ArrowLeft aria-hidden="true" className="size-4" />
        Projects
      </Link>

      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <ProjectKeyBadge projectKey={project.projectKey} />
            {archived && <ArchivedBadge />}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight break-words sm:text-3xl">{project.name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <ProjectStatusBadge status={project.status} />
            <ProjectPriorityBadge priority={project.priority} />
          </div>
        </div>
        {canManage && !archived && current === "overview" && (
          <Link href={`/projects/${project.id}/edit`} className={cn(secondaryButton, "shrink-0")}>
            <Pencil aria-hidden="true" className="size-4" />
            Edit project
          </Link>
        )}
      </header>

      {archived && (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-border bg-surface-muted px-4 py-3 text-sm">
          <Archive aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-secondary" />
          <p>
            Archived on <span className="font-medium">{formatProjectDate(project.archivedAt)}</span>. This project is read-only
            {canManage ? "; restore it to make changes." : "."}
          </p>
        </div>
      )}

      <ProjectSectionNav projectId={project.id} current={current} />
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
      <StatePanel
        tone="danger"
        icon={AlertTriangle}
        title="Couldn’t load this project"
        description={PROJECT_ERROR_MESSAGES[code]}
        action={<Link href={retryHref} className={panelButton}>Try again</Link>}
      />
    </main>
  );
}
