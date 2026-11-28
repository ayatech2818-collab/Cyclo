"use server";

import { requireActiveProfile } from "@/features/auth/server";

import { ProjectError } from "./errors";
import { getProject, listProjects } from "./queries.server";
import { isUuid, normalizeSearch } from "./validation";

/*
 * Reads for the sidebar's Current project switcher (Phase 8H). Both go
 * through the existing project RPCs, so visibility is decided by the database
 * exactly as on the Projects page.
 */

export type ProjectSummary = { id: string; name: string; projectKey: string; archived: boolean };

export async function getProjectSummaryAction(projectId: unknown): Promise<ProjectSummary | null> {
  if (!isUuid(projectId)) return null;
  try {
    const project = await getProject(projectId);
    return project ? { id: project.id, name: project.name, projectKey: project.projectKey, archived: Boolean(project.archivedAt) } : null;
  } catch (error) {
    if (error instanceof ProjectError) return null;
    throw error;
  }
}

export type ProjectSearchResult = { ok: true; projects: ProjectSummary[]; total: number } | { ok: false; error: string };

export async function searchProjectsAction(search: unknown): Promise<ProjectSearchResult> {
  await requireActiveProfile();
  const query = normalizeSearch(search);
  try {
    const page = await listProjects({
      search: query, status: null, priority: null, archived: false,
      sort: query ? "name_asc" : "updated_desc", view: "list", page: 1, pageSize: 20,
    });
    return {
      ok: true,
      total: page.total,
      projects: page.items.map((project) => ({ id: project.id, name: project.name, projectKey: project.projectKey, archived: Boolean(project.archivedAt) })),
    };
  } catch (error) {
    if (error instanceof ProjectError) return { ok: false, error: error.message };
    throw error;
  }
}
