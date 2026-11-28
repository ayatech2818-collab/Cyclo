import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ListTodo, Plus, SearchX } from "lucide-react";

import { PagePagination } from "@/components/shared/page-pagination";
import { requireActiveProfile } from "@/features/auth/server";
import { EmptyState } from "@/components/ui/empty-state";
import { panel, primaryButton, secondaryButton } from "@/components/ui/styles";
import { ProjectHeader, ProjectLoadError } from "@/features/projects/components/project-header";
import { PROJECT_ERROR_MESSAGES } from "@/features/projects/errors";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { getProject, listProjectMembers } from "@/features/projects/queries.server";
import { canManageProject, isUuid } from "@/features/projects/validation";
import { cn } from "@/lib/utils/cn";
import { WorkFilters } from "@/features/work-items/components/work-filters";
import { WorkList } from "@/features/work-items/components/work-list";
import { listWorkItems } from "@/features/work-items/queries.server";
import { creatableTypes, hasActiveWorkFilters, isWorkManager, parseWorkItemListQuery, workItemsHref } from "@/features/work-items/validation";

export const metadata: Metadata = { title: "Work | CYCLO" };

export default async function ProjectWorkPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { profile } = await requireActiveProfile();
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const query = parseWorkItemListQuery(await searchParams);

  // Project + team first (visibility is enforced by both RPCs; otherwise 404).
  const base = await loadProjectForPage(async () => {
    const [project, members] = await Promise.all([getProject(projectId), listProjectMembers(projectId)]);
    return { project, members };
  });
  if (base.error) return <ProjectLoadError code={base.error} retryHref={`/projects/${projectId}/work`} />;
  const { project, members } = base.data;
  if (!project) notFound();

  // The list is loaded separately so a list failure keeps the page usable.
  const list = await loadProjectForPage(() => listWorkItems(projectId, query));

  const isManager = isWorkManager(profile, project);
  const canCreate = !project.archivedAt && creatableTypes(isManager, profile.role).length > 0;
  const assignees = members.filter((member) => member.isActive).map((member) => ({
    id: member.profileId,
    name: member.fullName?.trim() || member.email || "Unnamed developer",
  }));

  const newButton = canCreate && (
    <Link href={`/projects/${projectId}/work/new`} className={primaryButton}>
      <Plus aria-hidden="true" className="size-4" />
      New work item
    </Link>
  );

  let body;
  if (list.error) {
    body = (
      <EmptyState tone="danger" icon={AlertTriangle} title="Couldn’t load work items" description={PROJECT_ERROR_MESSAGES[list.error]}
        action={<Link href={workItemsHref(projectId, query)} className={secondaryButton}>Try again</Link>} />
    );
  } else if (list.data.items.length > 0) {
    body = (
      <div className="space-y-4">
        <WorkList projectId={projectId} items={list.data.items} today={new Date().toISOString().slice(0, 10)} />
        <PagePagination page={query.page} pageSize={query.pageSize} pageCount={list.data.pageCount} total={list.data.total}
          noun={{ one: "work item", many: "work items" }} hrefFor={(page) => workItemsHref(projectId, query, { page })} />
      </div>
    );
  } else if (list.data.total > 0) {
    body = (
      <EmptyState icon={SearchX} title="This page is out of range" description={`There ${list.data.pageCount === 1 ? "is 1 page" : `are ${list.data.pageCount} pages`} of results.`}
        action={<Link href={workItemsHref(projectId, query, { page: 1 })} className={secondaryButton}>Go to first page</Link>} />
    );
  } else if (hasActiveWorkFilters(query)) {
    body = (
      <EmptyState icon={SearchX} title="No matching work items" description="Try another search or clear the filters."
        action={<Link href={workItemsHref(projectId, { ...query, search: "", type: null, status: null, priority: null, assignee: { kind: "any" }, page: 1 })} className={secondaryButton}>Clear filters</Link>} />
    );
  } else if (query.archived) {
    body = <EmptyState icon={ListTodo} title="No archived work items" description="Archived work items appear here. Their keys are never reused." />;
  } else {
    body = (
      <EmptyState icon={ListTodo} title="No work items yet"
        description={canCreate ? "Create an epic, story, task or bug to start planning this project." : "Work items created for this project will appear here."}
        action={newButton || undefined} />
    );
  }

  return (
    <main className="mx-auto w-full max-w-[88rem] space-y-6 px-4 py-6 sm:px-6 lg:py-8">
      <ProjectHeader project={project} canManage={canManageProject(profile, project)} current="work" />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-baseline gap-2.5 text-lg font-semibold tracking-tight">
            Work items
            {!list.error && (
              <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-text-secondary tabular-nums">
                {list.data.total}<span className="sr-only"> {list.data.total === 1 ? "item" : "items"}</span>
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-sm text-text-secondary">Epics, stories, tasks, subtasks and bugs.</p>
        </div>
        {newButton}
      </div>

      <section aria-label="Find work items" className={cn(panel, "p-4 sm:p-5")}>
        <WorkFilters projectId={projectId} query={query} assignees={assignees} selfId={profile.id} />
      </section>

      {body}
    </main>
  );
}
