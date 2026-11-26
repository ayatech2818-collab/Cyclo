import "server-only";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectError } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { createClient } from "@/lib/supabase/server";

import { rowsTotal, toCapacityRow, toSprint, toSprintDetail, toSprintItem } from "./logic";
import type { CapacityRow, SprintDetail, SprintItem, SprintPage, SprintScope } from "./types";

/* Server-only sprint reads. Visibility (SA, assigned PM, member developer) is decided by the RPCs. */

export async function listSprints(projectId: string, scope: SprintScope, page = 1, pageSize = 50): Promise<SprintPage> {
  await requireActiveProfile();
  if (!isUuid(projectId)) throw new ProjectError("not_found");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_sprints", { p_project_id: projectId, p_scope: scope, p_page: page, p_page_size: pageSize });
  if (error) failProject("list_sprints", error);
  const rows: unknown[] = data ?? [];
  const total = rowsTotal(rows);
  return { sprints: rows.map(toSprint), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Null when missing or not visible. */
export async function getSprint(sprintId: string): Promise<SprintDetail | null> {
  await requireActiveProfile();
  if (!isUuid(sprintId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_sprint", { p_sprint_id: sprintId });
  if (error) failProject("get_sprint", error);
  const rows: unknown[] = data ?? [];
  return rows.length ? toSprintDetail(rows[0]) : null;
}

export async function listSprintItems(sprintId: string): Promise<{ items: SprintItem[]; total: number }> {
  await requireActiveProfile();
  if (!isUuid(sprintId)) throw new ProjectError("not_found");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_sprint_items", { p_sprint_id: sprintId, p_page: 1, p_page_size: 100 });
  if (error) failProject("list_sprint_items", error);
  const rows: unknown[] = data ?? [];
  return { items: rows.map(toSprintItem), total: rowsTotal(rows) };
}

export async function getSprintCapacity(sprintId: string): Promise<CapacityRow[]> {
  await requireActiveProfile();
  if (!isUuid(sprintId)) throw new ProjectError("not_found");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("sprint_capacity", { p_sprint_id: sprintId });
  if (error) failProject("sprint_capacity", error);
  return ((data ?? []) as unknown[]).map(toCapacityRow);
}
