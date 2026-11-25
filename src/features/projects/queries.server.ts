import "server-only";

import { requireActiveProfile } from "@/features/auth/server";
import { createClient } from "@/lib/supabase/server";

import { projectTotalCount, toDeveloperOption, toProjectDetail, toProjectListItem, toProjectManagerOption, toProjectMember } from "./dto";
import { ProjectError, describeProjectFailure, mapProjectDatabaseError } from "./errors";
import type { DeveloperOption, ProjectDetail, ProjectListPage, ProjectListQuery, ProjectManagerOption, ProjectMember } from "./types";
import { canCreateProjects, isUuid, normalizeSearch } from "./validation";

/*
 * Server-only project reads. Visibility is decided by the database RPCs
 * (Super Admin: all, PM: assigned, Developer: projects they are members of);
 * the application only re-checks the session and parses rows into DTOs.
 */

type RpcError = { code?: string | null; message?: string | null };

export function failProject(operation: string, error: RpcError): never {
  const code = mapProjectDatabaseError(error);
  if (code === "unexpected" || code === "unavailable") console.error(describeProjectFailure(operation, error));
  throw new ProjectError(code);
}

export async function listProjects(query: ProjectListQuery): Promise<ProjectListPage> {
  await requireActiveProfile();
  const supabase = await createClient();

  const fetchPage = (page: number, pageSize: number) =>
    supabase.rpc("list_projects", {
      p_search: query.search || undefined,
      p_status: query.status ?? undefined,
      p_priority: query.priority ?? undefined,
      p_archived: query.archived,
      p_sort: query.sort,
      p_page: page,
      p_page_size: pageSize,
    });

  const { data, error } = await fetchPage(query.page, query.pageSize);
  if (error) failProject("list_projects", error);

  const rows: unknown[] = data ?? [];
  let total = projectTotalCount(rows);

  // A page past the end has no rows (and no count): probe once so the UI can
  // offer a way back instead of claiming there are no projects.
  if (rows.length === 0 && query.page > 1) {
    const probe = await fetchPage(1, 1);
    if (probe.error) failProject("list_projects", probe.error);
    total = projectTotalCount(probe.data ?? []);
  }

  return {
    items: rows.map(toProjectListItem),
    total,
    page: query.page,
    pageSize: query.pageSize,
    pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/** Returns null when the project does not exist or is not visible to the caller. */
export async function getProject(id: string): Promise<ProjectDetail | null> {
  await requireActiveProfile();
  if (!isUuid(id)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_project", { p_project_id: id });
  if (error) failProject("get_project", error);
  const rows: unknown[] = data ?? [];
  return rows.length ? toProjectDetail(rows[0]) : null;
}

/** Active Project Managers for assignment (Super Admin only). */
export async function listProjectManagerOptions(): Promise<ProjectManagerOption[]> {
  const { profile } = await requireActiveProfile();
  if (profile.role !== "SUPER_ADMIN") throw new ProjectError("forbidden");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_project_manager_options");
  if (error) failProject("list_project_manager_options", error);
  return ((data ?? []) as unknown[]).map(toProjectManagerOption);
}

/** Developer members of a project. Throws not_found when the caller cannot see the team. */
export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  await requireActiveProfile();
  if (!isUuid(projectId)) throw new ProjectError("not_found");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_project_members", { p_project_id: projectId });
  if (error) failProject("list_project_members", error);
  return ((data ?? []) as unknown[]).map(toProjectMember);
}

export const DEVELOPER_SEARCH_LIMIT = 20;

/** Active developers not yet on the team (Super Admin or the assigned PM). */
export async function searchAssignableDevelopers(projectId: string, search: unknown): Promise<DeveloperOption[]> {
  const { profile } = await requireActiveProfile();
  if (!canCreateProjects(profile.role)) throw new ProjectError("forbidden");
  if (!isUuid(projectId)) throw new ProjectError("not_found");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_assignable_developers", {
    p_project_id: projectId,
    p_search: normalizeSearch(search) || undefined,
    p_limit: DEVELOPER_SEARCH_LIMIT,
  });
  if (error) failProject("list_assignable_developers", error);
  return ((data ?? []) as unknown[]).map(toDeveloperOption);
}
