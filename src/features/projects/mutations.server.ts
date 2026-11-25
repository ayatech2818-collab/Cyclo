import "server-only";

import { requireActiveProfile } from "@/features/auth/server";
import { createClient } from "@/lib/supabase/server";

import { ProjectError } from "./errors";
import { failProject } from "./queries.server";
import type { CreateProjectValues, UpdateProjectValues } from "./types";
import { canCreateProjects, isUuid } from "./validation";

/*
 * Server-only project writes. The caller's identity always comes from the
 * verified session inside the database (auth.uid()); no actor id or role is
 * ever sent. App-level role checks only fail fast; the RPCs decide.
 */

async function rpcId(operation: string, call: () => PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>): Promise<string> {
  let result;
  try {
    result = await call();
  } catch {
    throw new ProjectError("unavailable");
  }
  if (result.error) failProject(operation, result.error);
  if (!isUuid(result.data)) throw new ProjectError("unexpected");
  return result.data;
}

function requireProjectId(id: string) {
  if (!isUuid(id)) throw new ProjectError("not_found");
}

export async function createProject(values: CreateProjectValues): Promise<string> {
  const { profile } = await requireActiveProfile();
  if (!canCreateProjects(profile.role)) throw new ProjectError("forbidden");
  const supabase = await createClient();
  return rpcId("create_project", () =>
    supabase.rpc("create_project", {
      p_name: values.name,
      p_project_key: values.projectKey,
      p_priority: values.priority,
      p_description: values.description ?? undefined,
      p_start_date: values.startDate ?? undefined,
      p_target_date: values.targetDate ?? undefined,
      // Only Super Admins choose; for PMs the database assigns the caller.
      p_project_manager_id: profile.role === "SUPER_ADMIN" ? (values.projectManagerId ?? undefined) : undefined,
    }),
  );
}

export async function updateProject(id: string, values: UpdateProjectValues): Promise<string> {
  const { profile } = await requireActiveProfile();
  if (!canCreateProjects(profile.role)) throw new ProjectError("forbidden");
  requireProjectId(id);
  const supabase = await createClient();
  return rpcId("update_project", () =>
    supabase.rpc("update_project", {
      p_project_id: id,
      p_name: values.name,
      p_status: values.status,
      p_priority: values.priority,
      p_description: values.description ?? undefined,
      p_start_date: values.startDate ?? undefined,
      p_target_date: values.targetDate ?? undefined,
    }),
  );
}

export async function assignProjectManager(id: string, projectManagerId: string): Promise<string> {
  const { profile } = await requireActiveProfile();
  if (profile.role !== "SUPER_ADMIN") throw new ProjectError("forbidden");
  requireProjectId(id);
  if (!isUuid(projectManagerId)) throw new ProjectError("invalid_project_manager");
  const supabase = await createClient();
  return rpcId("assign_project_manager", () =>
    supabase.rpc("assign_project_manager", { p_project_id: id, p_project_manager_id: projectManagerId }),
  );
}

export async function setProjectArchived(id: string, archived: boolean): Promise<string> {
  const { profile } = await requireActiveProfile();
  if (!canCreateProjects(profile.role)) throw new ProjectError("forbidden");
  requireProjectId(id);
  const supabase = await createClient();
  const name = archived ? "archive_project" : "restore_project";
  return rpcId(name, () => supabase.rpc(name, { p_project_id: id }));
}

/** Adds an active developer to the team (Super Admin or the assigned PM). */
export async function addProjectMember(projectId: string, profileId: string): Promise<string> {
  const { profile } = await requireActiveProfile();
  if (!canCreateProjects(profile.role)) throw new ProjectError("forbidden");
  requireProjectId(projectId);
  if (!isUuid(profileId)) throw new ProjectError("invalid_member");
  const supabase = await createClient();
  return rpcId("add_project_member", () =>
    supabase.rpc("add_project_member", { p_project_id: projectId, p_profile_id: profileId }),
  );
}

export async function removeProjectMember(projectId: string, profileId: string): Promise<string> {
  const { profile } = await requireActiveProfile();
  if (!canCreateProjects(profile.role)) throw new ProjectError("forbidden");
  requireProjectId(projectId);
  if (!isUuid(profileId)) throw new ProjectError("member_not_found");
  const supabase = await createClient();
  return rpcId("remove_project_member", () =>
    supabase.rpc("remove_project_member", { p_project_id: projectId, p_profile_id: profileId }),
  );
}
