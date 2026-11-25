import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";

import { requireActiveProfile } from "@/features/auth/server";
import { StatePanel, secondaryButton } from "@/features/employees/components/state-panel";
import { EditProjectForm } from "@/features/projects/components/project-form";
import { PROJECT_ERROR_MESSAGES } from "@/features/projects/errors";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { getProject } from "@/features/projects/queries.server";
import { canManageProject, isUuid } from "@/features/projects/validation";

export const metadata: Metadata = { title: "Edit project | CYCLO" };

export default async function EditProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { profile } = await requireActiveProfile();
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();

  const result = await loadProjectForPage(() => getProject(projectId));
  if (result.error) {
    return (
      <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
        <StatePanel
          tone="danger"
          icon={AlertTriangle}
          title="Couldn’t load this project"
          description={PROJECT_ERROR_MESSAGES[result.error]}
          action={<Link href={`/projects/${projectId}/edit`} className={secondaryButton}>Try again</Link>}
        />
      </main>
    );
  }

  const project = result.data;
  // Not visible, or visible but not manageable (no write access is disclosed either way).
  if (!project || !canManageProject(profile, project)) notFound();
  if (project.archivedAt) redirect(`/projects/${project.id}`);

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <Link href={`/projects/${project.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary">
        <ArrowLeft aria-hidden="true" className="size-4" />
        {project.name}
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Edit project</h1>
        <p className="mt-1 text-sm text-text-secondary">Update the project’s details, status and schedule.</p>
      </div>
      <EditProjectForm project={project} />
    </main>
  );
}
