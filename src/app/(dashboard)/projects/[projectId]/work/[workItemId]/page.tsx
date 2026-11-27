import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Archive, ArrowLeft, BadgeCheck, CornerLeftUp, KanbanSquare, MessageSquare, OctagonAlert, Plus, RotateCcw } from "lucide-react";

import { requireActiveProfile } from "@/features/auth/server";
import { CommentDiscussion } from "@/features/comments/components/comment-discussion";
import { listComments } from "@/features/comments/queries.server";
import { getMyResolvedAvatar } from "@/features/profile/avatars.server";
import { PROJECT_ERROR_MESSAGES } from "@/features/projects/errors";
import { ProjectPriorityBadge } from "@/features/projects/components/project-badges";
import { ActivityFeed } from "@/features/projects/components/project-activity";
import { ProjectLoadError } from "@/features/projects/components/project-header";
import { card, secondaryButton } from "@/features/projects/components/styles";
import { formatProjectDate } from "@/features/projects/format";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { getProject, listProjectActivity, listProjectMembers } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { IssueKey, WorkStatusBadge, WorkTypeBadge, WorkTypeIcon } from "@/features/work-items/components/work-badges";
import { AssigneeControl, HierarchyControl, PriorityControl, StatusControl, WorkItemArchiveControl, WorkItemContent } from "@/features/work-items/components/work-item-controls";
import { SprintStatusBadge } from "@/features/sprints/components/sprint-parts";
import { getWorkItemExecution } from "@/features/sprints/execution.server";
import { availableMoves } from "@/features/work-items/execution";
import { getWorkItem, listWorkItemChildren } from "@/features/work-items/queries.server";
import { TYPE_LABELS } from "@/features/work-items/types";
import { childTypesOf, creatableTypes, formatEstimate, isWorkManager, workItemPermissions } from "@/features/work-items/validation";
import { cn } from "@/lib/utils/cn";

// Same title for every item and for missing ones: existence is not disclosed.
export const metadata: Metadata = { title: "Work item | CYCLO" };

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-sm text-text-secondary">{term}</dt>
      <dd className="text-right text-sm font-medium">{children}</dd>
    </div>
  );
}

const notSet = <span className="font-normal text-text-muted">Not set</span>;

export default async function WorkItemPage({ params }: { params: Promise<{ projectId: string; workItemId: string }> }) {
  const { profile } = await requireActiveProfile();
  const { projectId, workItemId } = await params;
  if (!isUuid(projectId) || !isUuid(workItemId)) notFound();

  const [result, comments, myAvatar] = await Promise.all([
    loadProjectForPage(async () => {
      const [item, project, members, children, history, execution] = await Promise.all([
        getWorkItem(workItemId),
        getProject(projectId),
        listProjectMembers(projectId),
        listWorkItemChildren(workItemId),
        listProjectActivity(projectId, null, workItemId),
        getWorkItemExecution(workItemId),
      ]);
      return { item, project, members, children, history, execution };
    }),
    // Loaded alongside; a discussion failure keeps the rest of the page usable.
    loadProjectForPage(() => listComments(workItemId)),
    getMyResolvedAvatar(),
  ]);
  if (result.error) return <ProjectLoadError code={result.error} retryHref={`/projects/${projectId}/work/${workItemId}`} />;
  const { item, project, members, children, history, execution } = result.data;
  // An item from another project is treated as missing under this URL.
  if (!item || !project || item.projectId !== project.id) notFound();

  const permissions = workItemPermissions(profile, project, item);
  const isManager = isWorkManager(profile, project);
  const writable = !project.archivedAt && !item.archivedAt;
  const assignees = members.filter((member) => member.isActive).map((member) => ({
    id: member.profileId,
    name: member.fullName?.trim() || member.email || "Unnamed developer",
  }));
  const childTypes = childTypesOf(item.type).filter((type) => creatableTypes(isManager, profile.role).includes(type));
  const estimate = formatEstimate(item.estimate);
  const moves = availableMoves(item, { id: profile.id, isManager, writable });
  const sprint = execution?.sprintId && execution.sprintName && execution.sprintStatus
    ? { id: execution.sprintId, name: execution.sprintName, status: execution.sprintStatus } : null;
  const review = execution?.lastReview ?? null;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-sm text-text-secondary">
        <Link href={`/projects/${project.id}/work`} className="inline-flex items-center gap-1.5 font-medium hover:text-text-primary">
          <ArrowLeft aria-hidden="true" className="size-4" />
          {project.name} · Work
        </Link>
        {item.parent && (
          <>
            <span aria-hidden="true">/</span>
            <Link href={`/projects/${project.id}/work/${item.parent.id}`} className="inline-flex items-center gap-1 hover:text-text-primary">
              <CornerLeftUp aria-hidden="true" className="size-3.5" />
              <span className="font-mono text-xs">{item.parent.issueKey}</span>
            </Link>
          </>
        )}
      </nav>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <WorkTypeBadge type={item.type} />
          <IssueKey issueKey={item.issueKey} className="text-sm" />
          {item.archivedAt && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-text-secondary">
              <Archive aria-hidden="true" className="size-3.5" />Archived
            </span>
          )}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight break-words sm:text-3xl">{item.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <WorkStatusBadge status={item.status} />
          <ProjectPriorityBadge priority={item.priority} />
        </div>
      </header>

      {(project.archivedAt || item.archivedAt) && (
        <div role="status" className="rounded-lg border border-border bg-surface-muted px-4 py-3 text-sm">
          {project.archivedAt ? "This project is archived, so its work items are read-only." : `Archived on ${formatProjectDate(item.archivedAt)}. This work item is read-only${isManager ? "; restore it to make changes." : "."}`}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <section className={cn(card, "p-5 sm:p-6")} aria-label="Description">
            <WorkItemContent key={item.updatedAt} item={item} canEdit={permissions.canEdit} />
          </section>

          {(children.length > 0 || (writable && childTypes.length > 0)) && (
            <section className={cn(card, "overflow-hidden")} aria-labelledby="wi-children">
              <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5 sm:px-6">
                <h2 id="wi-children" className="text-base font-semibold">
                  Child items <span className="ml-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-text-secondary">{children.length}</span>
                </h2>
                {writable && childTypes.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {childTypes.map((type) => (
                      <Link key={type} href={`/projects/${project.id}/work/new?type=${type}&parent=${item.id}`} className={cn(secondaryButton, "h-8 px-2.5 text-xs")}>
                        <Plus aria-hidden="true" className="size-3.5" />{TYPE_LABELS[type]}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
              {children.length === 0 ? (
                <p className="px-5 py-6 text-sm text-text-secondary sm:px-6">No child items yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {children.map((child) => (
                    <li key={child.id} className={cn("relative flex items-center gap-3 px-5 py-3 hover:bg-surface-muted/50 sm:px-6", child.archivedAt && "opacity-60")}>
                      <WorkTypeIcon type={child.type} />
                      <IssueKey issueKey={child.issueKey} />
                      <Link href={`/projects/${project.id}/work/${child.id}`} className="min-w-0 flex-1 truncate text-sm font-medium after:absolute after:inset-0 hover:text-primary">{child.title}</Link>
                      <span className="hidden text-xs text-text-secondary sm:inline">{child.assigneeName ?? "Unassigned"}</span>
                      <WorkStatusBadge status={child.status} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className={cn(card, "p-5 sm:p-6")} aria-labelledby="wi-discussion">
            <h2 id="wi-discussion" className="mb-4 flex items-center gap-2 text-base font-semibold">
              <MessageSquare aria-hidden="true" className="size-4 text-text-secondary" />Discussion
            </h2>
            {comments.error ? (
              <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm">
                <p><span className="font-medium text-danger">Couldn’t load the discussion.</span> {PROJECT_ERROR_MESSAGES[comments.error]}</p>
                <Link href={`/projects/${project.id}/work/${item.id}`} className={cn(secondaryButton, "h-8 px-3 text-xs")}>Try again</Link>
              </div>
            ) : (
              <CommentDiscussion workItemId={item.id} initialPage={comments.data} canWrite={writable}
                viewer={{ id: profile.id, name: profile.full_name?.trim() || null, avatar: myAvatar ?? { type: "initials" } }} />
            )}
          </section>

          <section className={cn(card, "overflow-hidden")} aria-labelledby="wi-history">
            <div className="border-b border-border px-5 py-3.5 sm:px-6">
              <h2 id="wi-history" className="text-base font-semibold">History</h2>
            </div>
            {/* Keyed on updatedAt: every change on this page re-seeds the history. */}
            <ActivityFeed key={item.updatedAt} projectId={project.id} workItemId={item.id} initialEntries={history.entries} initialCursor={history.nextCursor} emptyText="Changes to this work item will appear here." />
          </section>
        </div>

        <aside className="space-y-6">
          <section className={cn(card, "space-y-4 p-5")} aria-labelledby="wi-status-heading">
            <h2 id="wi-status-heading" className="text-sm font-semibold text-text-secondary">Status</h2>
            {item.status === "BLOCKED" && (
              <p className="flex gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
                <OctagonAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 break-words"><span className="font-medium">Blocked:</span> {execution?.blockedReason ?? "No reason recorded."}</span>
              </p>
            )}
            {/* Keyed on status: a finished move resets the control to the new state's actions. */}
            <StatusControl key={item.status} item={item} moves={moves} sprintId={sprint?.id ?? null} />
            {review && (
              <div className="border-t border-border pt-3 text-xs">
                <p className={cn("flex items-center gap-1.5 font-medium", review.decision === "approved" ? "text-success" : "text-warning")}>
                  {review.decision === "approved" ? <BadgeCheck aria-hidden="true" className="size-3.5" /> : <RotateCcw aria-hidden="true" className="size-3.5" />}
                  {review.decision === "approved" ? "Review approved" : "Changes requested"}
                </p>
                <p className="mt-0.5 text-text-muted">{review.by ?? "Former employee"} · {formatProjectDate(review.at)}</p>
                {review.reason && <p className="mt-1.5 break-words text-text-secondary">“{review.reason}”</p>}
              </div>
            )}
          </section>

          <section className={cn(card, "space-y-3 p-5")} aria-labelledby="wi-sprint-heading">
            <h2 id="wi-sprint-heading" className="text-sm font-semibold text-text-secondary">Sprint</h2>
            {sprint ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/projects/${project.id}/sprints/${sprint.id}`} className="min-w-0 truncate text-sm font-medium hover:text-primary">{sprint.name}</Link>
                  <SprintStatusBadge status={sprint.status} />
                </div>
                {sprint.status !== "PLANNING" && (
                  <Link href={`/projects/${project.id}/sprints/${sprint.id}/board`} className={cn(secondaryButton, "h-8 w-full px-2.5 text-xs")}>
                    <KanbanSquare aria-hidden="true" className="size-3.5" />{sprint.status === "ACTIVE" ? "Open sprint board" : "View sprint board"}
                  </Link>
                )}
              </>
            ) : (
              <p className="text-sm text-text-muted">{item.type === "EPIC" || item.type === "SUBTASK" ? "Not scheduled directly." : "Not in a sprint (backlog)."}</p>
            )}
          </section>

          <section className={cn(card, "space-y-4 p-5")} aria-labelledby="wi-details-heading">
            <h2 id="wi-details-heading" className="text-sm font-semibold text-text-secondary">Details</h2>
            {permissions.canManage && writable ? (
              <>
                <AssigneeControl item={item} assignees={assignees} />
                <PriorityControl item={item} />
              </>
            ) : null}
            <dl className="divide-y divide-border">
              {!(permissions.canManage && writable) && (
                <Detail term="Assignee">
                  {item.assigneeName ?? <span className="font-normal text-text-muted">Unassigned</span>}
                </Detail>
              )}
              {item.assigneeId && !item.assigneeIsEligible && (
                <p className="py-2 text-xs text-warning">The assignee is no longer an active developer on this team.</p>
              )}
              <Detail term="Reporter">{item.reporterName ?? "Former employee"}</Detail>
              <Detail term="Start date">{formatProjectDate(item.startDate) ?? notSet}</Detail>
              <Detail term="Due date">{formatProjectDate(item.dueDate) ?? notSet}</Detail>
              {item.type !== "EPIC" && <Detail term="Estimate">{estimate ?? notSet}</Detail>}
              <Detail term="Created">{formatProjectDate(item.createdAt)}</Detail>
              <Detail term="Updated">{formatProjectDate(item.updatedAt)}</Detail>
              {item.completedAt && <Detail term="Completed">{formatProjectDate(item.completedAt)}</Detail>}
            </dl>
          </section>

          {permissions.canManage && (
            <section className={cn(card, "space-y-4 p-5")} aria-labelledby="wi-structure-heading">
              <h2 id="wi-structure-heading" className="text-sm font-semibold text-text-secondary">Type and parent</h2>
              {writable ? (
                <HierarchyControl key={item.updatedAt} item={item} />
              ) : (
                <p className="text-xs text-text-secondary">Restore the work item to change its type or parent.</p>
              )}
              <div className="border-t border-border pt-4">
                <WorkItemArchiveControl item={item} />
              </div>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
