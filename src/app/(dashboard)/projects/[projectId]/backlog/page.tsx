import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Inbox, SearchX } from "lucide-react";

import { PagePagination } from "@/components/shared/page-pagination";
import { requireActiveProfile } from "@/features/auth/server";
import { BacklogBoard, QuickCreate } from "@/features/backlog/components/backlog-board";
import { BacklogFilters } from "@/features/backlog/components/backlog-filters";
import { BacklogSummaryPanel } from "@/features/backlog/components/backlog-summary";
import { CLEARED_FILTERS, backlogHref, hasBacklogFilters, parseBacklogQuery } from "@/features/backlog/logic";
import { getBacklogSummary, listBacklog } from "@/features/backlog/queries.server";
import { QUICK_CREATE_TYPES } from "@/features/backlog/types";
import { StatePanel, secondaryButton } from "@/features/employees/components/state-panel";
import { ProjectHeader, ProjectLoadError } from "@/features/projects/components/project-header";
import { PROJECT_ERROR_MESSAGES } from "@/features/projects/errors";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { getProject, listProjectMembers } from "@/features/projects/queries.server";
import { canManageProject, isUuid } from "@/features/projects/validation";
import { creatableTypes, isWorkManager } from "@/features/work-items/validation";

export const metadata: Metadata = { title: "Backlog | CYCLO" };

export default async function ProjectBacklogPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { profile } = await requireActiveProfile();
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const query = parseBacklogQuery(await searchParams);

  // Project, team and summary: visibility enforced by each RPC (otherwise 404).
  const base = await loadProjectForPage(async () => {
    const [project, members, summary] = await Promise.all([getProject(projectId), listProjectMembers(projectId), getBacklogSummary(projectId)]);
    return { project, members, summary };
  });
  if (base.error) return <ProjectLoadError code={base.error} retryHref={`/projects/${projectId}/backlog`} />;
  const { project, members, summary } = base.data;
  if (!project) notFound();

  const list = await loadProjectForPage(() => listBacklog(projectId, query));

  const writable = !project.archivedAt;
  const canPlan = writable && isWorkManager(profile, project);
  const quickCreateTypes = writable ? QUICK_CREATE_TYPES.filter((type) => creatableTypes(isWorkManager(profile, project), profile.role).includes(type)) : [];
  const assignees = members.filter((member) => member.isActive).map((member) => ({
    id: member.profileId,
    name: member.fullName?.trim() || member.email || "Unnamed developer",
  }));

  let body;
  if (list.error) {
    body = <StatePanel tone="danger" icon={AlertTriangle} title="Couldn’t load the backlog" description={PROJECT_ERROR_MESSAGES[list.error]}
      action={<Link href={backlogHref(projectId, query)} className={secondaryButton}>Try again</Link>} />;
  } else if (list.data.items.length === 0 && list.data.total > 0) {
    body = <StatePanel icon={SearchX} title="This page is out of range" description="Go back to the first page of the backlog."
      action={<Link href={backlogHref(projectId, query, { page: 1 })} className={secondaryButton}>Go to first page</Link>} />;
  } else if (list.data.items.length === 0 && hasBacklogFilters(query)) {
    body = <StatePanel icon={SearchX} title="No matching work" description="Try another search, or clear the filters."
      action={<Link href={backlogHref(projectId, query, CLEARED_FILTERS)} className={secondaryButton}>Clear filters</Link>} />;
  } else if (list.data.items.length === 0 && quickCreateTypes.length === 0) {
    body = <StatePanel icon={Inbox} title="The backlog is empty" description="Stories, tasks and bugs waiting for work will appear here." />;
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <ProjectHeader project={project} canManage={canManageProject(profile, project)} current="backlog" />
      <div className="flex flex-col gap-1">
        <p className="text-sm text-text-secondary">
          Open stories, tasks and bugs in priority order. <span className="text-text-primary">Backlog</span> means waiting for planning,{" "}
          <span className="text-text-primary">To do</span> means ready to pick up. Reordering never changes status.
        </p>
        {canPlan && <p className="text-xs text-text-muted">Drag rows (or focus a row and press Alt+↑/↓) to reorder within a section. Select rows to change priority or assignee in bulk.</p>}
      </div>

      <BacklogSummaryPanel projectId={projectId} query={query} summary={summary} />
      <BacklogFilters projectId={projectId} query={query} assignees={assignees} epics={summary.epics} selfId={profile.id} />

      {quickCreateTypes.length > 0 && !list.error && <QuickCreate projectId={projectId} types={quickCreateTypes} />}

      {body ?? (
        <div className="space-y-4">
          {list.data && (
            <BacklogBoard
              // Re-seed local order after every server change (move, bulk edit, create, filter).
              key={list.data.items.map((item) => `${item.id}:${item.status}:${item.priority}:${item.assigneeId}`).join("|")}
              projectId={projectId}
              items={list.data.items}
              group={query.group}
              canPlan={canPlan}
              assignees={assignees}
            />
          )}
          {list.data && list.data.items.length === 0 && (
            <p className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-text-secondary">The backlog is empty. Add a task or bug above.</p>
          )}
          {list.data && list.data.total > 0 && (
            <PagePagination page={query.page} pageSize={query.pageSize} pageCount={list.data.pageCount} total={list.data.total}
              noun={{ one: "item", many: "items" }} hrefFor={(page) => backlogHref(projectId, query, { page })} />
          )}
        </div>
      )}
    </main>
  );
}
