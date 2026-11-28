import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";

import { getRequestAccess, requireActiveProfile } from "@/features/auth/server";
import { EmptyState } from "@/components/ui/empty-state";
import { secondaryButton } from "@/components/ui/styles";
import { CreateProjectForm } from "@/features/projects/components/project-form";
import { PROJECT_ERROR_MESSAGES } from "@/features/projects/errors";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { listProjectManagerOptions } from "@/features/projects/queries.server";
import { canCreateProjects } from "@/features/projects/validation";

export async function generateMetadata(): Promise<Metadata> {
  const access = await getRequestAccess();
  const allowed = access.status === "authorized" && canCreateProjects(access.profile.role);
  return { title: allowed ? "New project | CYCLO" : "Page not found | CYCLO" };
}

export default async function NewProjectPage() {
  const { profile } = await requireActiveProfile();
  // Developers cannot create projects; the RPC enforces this independently.
  if (!canCreateProjects(profile.role)) notFound();

  const isSuperAdmin = profile.role === "SUPER_ADMIN";
  const options = isSuperAdmin ? await loadProjectForPage(listProjectManagerOptions) : null;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <Link href="/projects" className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary">
        <ArrowLeft aria-hidden="true" className="size-4" />
        Projects
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {isSuperAdmin
            ? "Create a project and assign its Project Manager."
            : "Create a project. You will be assigned as its Project Manager."}
        </p>
      </div>
      {options?.error ? (
        <EmptyState
          tone="danger"
          icon={AlertTriangle}
          title="Couldn’t load Project Managers"
          description={PROJECT_ERROR_MESSAGES[options.error]}
          action={<Link href="/projects/new" className={secondaryButton}>Try again</Link>}
        />
      ) : (
        <CreateProjectForm
          managerOptions={options ? options.data : null}
          selfName={profile.full_name?.trim() || profile.email || "You"}
        />
      )}
    </main>
  );
}
