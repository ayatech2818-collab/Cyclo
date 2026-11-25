import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Archive, ArrowLeft, Pencil, UserRound } from "lucide-react";

import { requireActiveProfile } from "@/features/auth/server";
import { StatePanel, secondaryButton as panelButton } from "@/features/employees/components/state-panel";
import { ArchivedBadge, ProjectKeyBadge, ProjectPriorityBadge, ProjectStatusBadge } from "@/features/projects/components/project-badges";
import { ArchiveControl, AssignManagerForm } from "@/features/projects/components/project-manage";
import { ProjectSectionNav } from "@/features/projects/components/project-section-nav";
import { card, secondaryButton } from "@/features/projects/components/styles";
import { PROJECT_ERROR_MESSAGES } from "@/features/projects/errors";
import { formatProjectDate, managerLabel } from "@/features/projects/format";
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

  const back = (
    <Link href="/projects" className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary">
      <ArrowLeft aria-hidden="true" className="size-4" />
      Projects
    </Link>
  );

  const result = await loadProjectForPage(() => getProject(projectId));
  if (result.error) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        {back}
        <StatePanel
          tone="danger"
          icon={AlertTriangle}
          title="Couldn’t load this project"
          description={PROJECT_ERROR_MESSAGES[result.error]}
          action={<Link href={`/projects/${projectId}`} className={panelButton}>Try again</Link>}
        />
      </main>
    );
  }

  const project = result.data;
  if (!project) notFound();

  const canManage = canManageProject(profile, project);
  const canAssign = canAssignProjectManager(profile.role);
  const archived = Boolean(project.archivedAt);
  // Decorative for the reassign form; a failure leaves the form disabled.
  const managerOptions = canAssign ? await listProjectManagerOptions().catch(() => null) : null;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      {back}

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
        {canManage && !archived && (
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

      <ProjectSectionNav projectId={project.id} current="overview" />

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
            <h2 id="project-manager" className="text-sm font-semibold text-text-secondary">Project Manager</h2>
            <div className="mt-3 flex items-center gap-3">
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
