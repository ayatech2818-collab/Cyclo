"use server";

import { revalidatePath } from "next/cache";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectError } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { createClient } from "@/lib/supabase/server";

import { isExecutionAction, parseReason, toExecutionResult, type ExecutionResult } from "./execution";
import { isWorkItemStatus } from "./validation";

export type MoveResult =
  | { ok: true; item: Pick<ExecutionResult, "id" | "status" | "blockedFromStatus" | "blockedReason"> & { updatedAt: string | null }; changed: boolean; message: string }
  | { ok: false; error: string; code: ProjectError["code"]; /** The item changed underneath: refresh it. */ conflict: boolean };

const SUCCESS: Record<string, string> = {
  start: "Work started.",
  submit_review: "Submitted for review.",
  block: "Marked blocked.",
  resume: "Work resumed.",
  approve: "Approved. The item is done.",
  reject: "Changes requested. The item is back in progress.",
};

function failure(error: unknown): MoveResult {
  if (!(error instanceof ProjectError)) throw error;
  return { ok: false, error: error.message, code: error.code, conflict: error.code === "status_changed" || error.code === "invalid_transition" };
}

/**
 * One board/detail move. Execution actions go through execute_work_item with the
 * status the viewer saw (a stale view fails with status_changed; a retry of a
 * move that already succeeded is a no-op). Other moves use the generic transition.
 *
 * `refresh` re-renders the work item and sprint pages; the board passes false
 * and applies the returned item itself (no full-board reload).
 */
export async function moveWorkItemAction(input: {
  projectId: string;
  sprintId: string | null;
  workItemId: string;
  from: string;
  to: string;
  action: string | null;
  reason: string | null;
  refresh: boolean;
}): Promise<MoveResult> {
  const { projectId, sprintId, workItemId, from, to, action } = input;
  if (!isUuid(projectId) || !isUuid(workItemId) || (sprintId !== null && !isUuid(sprintId))) return failure(new ProjectError("not_found"));
  if (!isWorkItemStatus(from) || !isWorkItemStatus(to)) return failure(new ProjectError("invalid_status"));
  if (action !== null && !isExecutionAction(action)) return failure(new ProjectError("invalid_action"));
  const reason = action === "block" || action === "reject" ? parseReason(input.reason) : null;
  if ((action === "block" || action === "reject") && reason === null) return failure(new ProjectError("reason_required"));

  await requireActiveProfile();
  const client = await createClient();
  let result: MoveResult;
  try {
    if (action) {
      let response;
      try {
        response = await client.rpc("execute_work_item", { p_work_item_id: workItemId, p_action: action, p_expected_status: from, p_reason: reason ?? undefined });
      } catch {
        throw new ProjectError("unavailable");
      }
      if (response.error) failProject("execute_work_item", response.error);
      const rows = (response.data ?? []) as unknown[];
      if (rows.length !== 1) throw new ProjectError("unexpected");
      const item = toExecutionResult(rows[0]);
      result = { ok: true, item, changed: item.changed, message: item.changed ? SUCCESS[action] : "Already done." };
    } else {
      let response;
      try {
        response = await client.rpc("change_work_item_status", { p_work_item_id: workItemId, p_status: to });
      } catch {
        throw new ProjectError("unavailable");
      }
      if (response.error) failProject("change_work_item_status", response.error);
      result = { ok: true, item: { id: workItemId, status: to, blockedFromStatus: null, blockedReason: null, updatedAt: null }, changed: true, message: "Status updated." };
    }
  } catch (error) {
    return failure(error);
  }

  if (input.refresh) {
    revalidatePath(`/projects/${projectId}/work/${workItemId}`);
    if (sprintId) revalidatePath(`/projects/${projectId}/sprints/${sprintId}`);
  }
  return result;
}
