import "server-only";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectError } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { toBoardItem, toExecutionContext, toSprintProgress, type BoardItem, type ExecutionContext, type SprintProgress } from "@/features/work-items/execution";
import { createClient } from "@/lib/supabase/server";

import { toBurndownDay, type BurndownDay } from "./burndown";

/*
 * Server-only execution reads (Phase 8F2). One bounded RPC each, no per-item
 * queries; visibility is decided by the database (SA, assigned PM, member developer).
 */

/** Board cards: not archived, not cancelled, at most 500 (the database bound). */
export async function listSprintBoard(sprintId: string): Promise<BoardItem[]> {
  await requireActiveProfile();
  if (!isUuid(sprintId)) throw new ProjectError("not_found");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_sprint_board", { p_sprint_id: sprintId });
  if (error) failProject("list_sprint_board", error);
  return ((data ?? []) as unknown[]).map(toBoardItem);
}

export async function getSprintProgress(sprintId: string): Promise<SprintProgress> {
  await requireActiveProfile();
  if (!isUuid(sprintId)) throw new ProjectError("not_found");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("sprint_progress", { p_sprint_id: sprintId });
  if (error) failProject("sprint_progress", error);
  return toSprintProgress((data ?? []) as unknown[]);
}

/** One row per sprint day up to today/completion; empty for a sprint that never started. */
export async function getSprintBurndown(sprintId: string): Promise<BurndownDay[]> {
  await requireActiveProfile();
  if (!isUuid(sprintId)) throw new ProjectError("not_found");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("sprint_burndown", { p_sprint_id: sprintId });
  if (error) failProject("sprint_burndown", error);
  return ((data ?? []) as unknown[]).map(toBurndownDay);
}

/** Sprint, blocked reason and latest review decision for one work item. */
export async function getWorkItemExecution(workItemId: string): Promise<ExecutionContext | null> {
  await requireActiveProfile();
  if (!isUuid(workItemId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("work_item_execution", { p_work_item_id: workItemId });
  if (error) {
    if (error.code === "P0002") return null;
    failProject("work_item_execution", error);
  }
  const rows = (data ?? []) as unknown[];
  return rows.length ? toExecutionContext(rows[0]) : null;
}
