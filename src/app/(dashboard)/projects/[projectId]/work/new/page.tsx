import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectLoadError } from "@/features/projects/components/project-header";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { getProject, listProjectMembers } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { CreateWorkItemForm } from "@/features/work-items/components/work-item-form";
import { getWorkItem } from "@/features/work-items/queries.server";
import { creatableTypes, isParentAllowed, isWorkItemType, isWorkManager } from "@/features/work-items/validation";

export const metadata: Metadata = { title: "New work item | CYCLO" };

/** Optional ?type=SUBTASK&parent=<id> pre-fills the form (e.g. "Add subtask"). */
export default async function NewWorkItemPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { profile } = await requireActiveProfile();
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const search = await searchParams;

  const result = await loadProjectForPage(async () => {
    const [project, members] = await Promise.all([getProject(projectId), listProjectMembers(projectId)]);
    const parentId = typeof search.parent === "string" && isUuid(search.parent) ? search.parent : null;
    const parent = parentId ? await getWorkItem(parentId) : null;
    return { project, members, parent };
  });
  if (result.error) return <ProjectLoadError code={result.error} retryHref={`/projects/${projectId}/work/new`} />;
  const { project, members, parent } = result.data;
  if (!project) notFound();

  const isManager = isWorkManager(profile, project);
  const allowedTypes = creatableTypes(isManager, profile.role);
  // Nothing to create (or an archived project): the page does not exist for this viewer.
  if (allowedTypes.length === 0 || project.archivedAt) notFound();

  const activeMembers = members.filter((member) => member.isActive);
  const assignees = (isManager ? activeMembers : activeMembers.filter((member) => member.profileId === profile.id)).map((member) => ({
    id: member.profileId,
    name: member.fullName?.trim() || member.email || "Unnamed developer",
  }));

  const requestedType = typeof search.type === "string" && isWorkItemType(search.type) && allowedTypes.includes(search.type) ? search.type : null;
  const validParent = parent && parent.projectId === project.id && !parent.archivedAt ? parent : null;
  const initialType = requestedType ?? (allowedTypes.includes("TASK") ? "TASK" : allowedTypes[0]);
  const initialParent = validParent && isParentAllowed(initialType, validParent.type)
    ? { id: validParent.id, issueKey: validParent.issueKey, title: validParent.title, type: validParent.type }
    : null;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <Link href={`/projects/${projectId}/work`} className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary">
        <ArrowLeft aria-hidden="true" className="size-4" />
        {project.name} · Work
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New work item</h1>
        <p className="mt-1 text-sm text-text-secondary">
          The key ({project.projectKey}-…) is assigned automatically when you save.
          {!isManager && " Developers can create tasks and bugs."}
        </p>
      </div>
      <CreateWorkItemForm
        projectId={project.id}
        allowedTypes={allowedTypes}
        isManager={isManager}
        selfId={profile.id}
        assignees={assignees}
        initialType={initialType}
        initialParent={initialParent}
      />
    </main>
  );
}
