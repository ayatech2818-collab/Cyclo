"use server";

import { revalidatePath } from "next/cache";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectError } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { createWorkItem } from "@/features/work-items/mutations.server";
import { createClient } from "@/lib/supabase/server";

import { parseBulkChange, validateQuickCreate } from "./logic";

export type BacklogActionResult = { error: string | null; success: string | null };

const fail = (error: unknown): BacklogActionResult => {
  if (!(error instanceof ProjectError)) throw error; // redirects and unexpected errors propagate
  return { error: error.message, success: null };
};

function revalidateBacklog(projectId: string) {
  revalidatePath(`/projects/${projectId}/backlog`);
  revalidatePath(`/projects/${projectId}/work`);
  revalidatePath(`/projects/${projectId}/activity`);
}

/** Persist a drag: the database places the item right after `afterId` (or before `beforeId`). */
export async function moveBacklogItemAction(projectId: string, workItemId: string, afterId: string | null, beforeId: string | null): Promise<BacklogActionResult> {
  await requireActiveProfile();
  if (!isUuid(projectId) || !isUuid(workItemId) || (afterId !== null && !isUuid(afterId)) || (beforeId !== null && !isUuid(beforeId)) || (!afterId && !beforeId)) {
    return fail(new ProjectError("invalid_position"));
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("move_backlog_item", {
    p_work_item_id: workItemId,
    p_after_id: afterId ?? undefined,
    p_before_id: beforeId ?? undefined,
  });
  try {
    if (error) failProject("move_backlog_item", error);
  } catch (caught) {
    return fail(caught);
  }
  revalidateBacklog(projectId);
  return { error: null, success: null };
}

export async function bulkUpdateAction(projectId: string, workItemIds: string[], priority: string, assignee: string): Promise<BacklogActionResult> {
  await requireActiveProfile();
  const change = parseBulkChange(priority, assignee);
  if (!change) return fail(new ProjectError("invalid_bulk_change"));
  if (!isUuid(projectId) || !Array.isArray(workItemIds) || workItemIds.length < 1 || workItemIds.length > 100 || !workItemIds.every(isUuid)) {
    return fail(new ProjectError("invalid_selection"));
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("bulk_update_work_items", {
    p_project_id: projectId,
    p_work_item_ids: workItemIds,
    p_change_priority: change.priority !== null,
    p_priority: change.priority ?? undefined,
    p_change_assignee: change.assignee.set,
    p_assignee_id: change.assignee.set ? (change.assignee.id ?? undefined) : undefined,
  });
  try {
    if (error) failProject("bulk_update_work_items", error);
  } catch (caught) {
    return fail(caught);
  }
  revalidateBacklog(projectId);
  return { error: null, success: `Updated ${workItemIds.length} item${workItemIds.length === 1 ? "" : "s"}.` };
}

/** Quick-create a Task or Bug at the bottom of the backlog (existing create rules apply). */
export async function quickCreateAction(projectId: string, type: string, title: string): Promise<BacklogActionResult> {
  await requireActiveProfile();
  const input = validateQuickCreate(type, title);
  if (!input.ok) return { error: input.error, success: null };
  try {
    await createWorkItem(projectId, {
      type: input.type, title: input.title, description: null, parentId: null, status: "BACKLOG",
      priority: "medium", assigneeId: null, startDate: null, dueDate: null, estimate: null,
    });
  } catch (error) {
    return fail(error);
  }
  revalidateBacklog(projectId);
  return { error: null, success: `${input.type === "BUG" ? "Bug" : "Task"} created.` };
}
