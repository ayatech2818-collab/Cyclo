import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, Archive, FolderKanban, Plus, SearchX } from "lucide-react";

import { requireActiveProfile } from "@/features/auth/server";
import { cn } from "@/lib/utils/cn";
import { EmptyState } from "@/components/ui/empty-state";

import { ProjectGrid, ProjectTable } from "@/features/projects/components/project-collection";
import { ProjectFilters, ProjectScopeBar, ProjectStatusChips } from "@/features/projects/components/project-filters";
import { ProjectPagination } from "@/features/projects/components/project-pagination";
import { panel, primaryButton, secondaryButton } from "@/components/ui/styles";
import { PROJECT_ERROR_MESSAGES } from "@/features/projects/errors";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { listProjects } from "@/features/projects/queries.server";
import { canCreateProjects, hasActiveFilters, parseProjectListQuery, projectsHref } from "@/features/projects/validation";

export const metadata: Metadata = { title: "Projects | CYCLO" };

export default async function ProjectsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { profile } = await requireActiveProfile();
  const query = parseProjectListQuery(await searchParams);
  const result = await loadProjectForPage(() => listProjects(query));
  const canCreate = canCreateProjects(profile.role);
  const today = new Date().toISOString().slice(0, 10);

  const newProject = canCreate && (
    <Link href="/projects/new" className={primaryButton}>
      <Plus aria-hidden="true" className="size-4" />
      New project
    </Link>
  );

  let body;
  if (result.error) {
    body = (
      <EmptyState
        tone="danger"
        icon={AlertTriangle}
        title="Couldn’t load projects"
        description={PROJECT_ERROR_MESSAGES[result.error]}
        action={<Link href={projectsHref(query)} className={secondaryButton}>Try again</Link>}
      />
    );
  } else if (result.data.items.length > 0) {
    body = (
      <div className="space-y-4">
        {query.view === "list" ? <ProjectTable projects={result.data.items} today={today} /> : <ProjectGrid projects={result.data.items} today={today} />}
        <ProjectPagination query={query} pageCount={result.data.pageCount} total={result.data.total} />
      </div>
    );
  } else if (result.data.total > 0) {
    body = (
      <EmptyState
        icon={SearchX}
        title="This page is out of range"
        description={`There ${result.data.pageCount === 1 ? "is 1 page" : `are ${result.data.pageCount} pages`} of results.`}
        action={<Link href={projectsHref(query, { page: 1 })} className={secondaryButton}>Go to first page</Link>}
      />
    );
  } else if (hasActiveFilters(query)) {
    body = (
      <EmptyState
        icon={SearchX}
        title="No matching projects"
        description="Try a different name or key, or clear the filters."
        action={<Link href={projectsHref({ ...query, search: "", status: null, priority: null, page: 1 })} className={secondaryButton}>Clear filters</Link>}
      />
    );
  } else if (query.archived) {
    body = <EmptyState icon={Archive} title="No archived projects" description="Archived projects appear here. Archiving keeps all project data and can be undone." />;
  } else if (profile.role === "DEVELOPER") {
    body = (
      <EmptyState
        icon={FolderKanban}
        title="No projects yet"
        description="Projects you are added to will appear here. Ask your Project Manager if you expect to see a project."
      />
    );
  } else {
    body = (
      <EmptyState
        icon={FolderKanban}
        title="No projects yet"
        description={profile.role === "SUPER_ADMIN" ? "Create the first project and assign a Project Manager." : "Create a project to get started. You will be its Project Manager."}
        action={newProject || undefined}
      />
    );
  }

  const subtitle =
    profile.role === "SUPER_ADMIN"
      ? "All projects across AyaTech."
      : profile.role === "PROJECT_MANAGER"
        ? "Projects you manage."
        : "Projects you are a member of.";

  const total = result.error ? null : result.data.total;

  return (
    <main className="mx-auto w-full max-w-[88rem] space-y-6 px-4 py-6 sm:px-6 lg:py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-baseline gap-3 text-2xl font-semibold tracking-tight sm:text-3xl">
            Projects
            {total !== null && (
              <span className="rounded-full bg-surface-muted px-2.5 py-0.5 text-sm font-medium text-text-secondary tabular-nums">
                {total}<span className="sr-only"> {query.archived ? "archived" : "active"} {total === 1 ? "project" : "projects"}{hasActiveFilters(query) ? " matching the filters" : ""}</span>
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">{subtitle}</p>
        </div>
        {newProject}
      </div>

      <section aria-label="Find projects" className={cn(panel, "space-y-4 p-4 sm:p-5")}>
        <ProjectScopeBar query={query} />
        <ProjectStatusChips query={query} />
        <div className="border-t border-border pt-4">
          <ProjectFilters query={query} />
        </div>
      </section>

      {body}
    </main>
  );
}
