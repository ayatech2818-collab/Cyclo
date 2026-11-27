"use server";

import { revalidatePath } from "next/cache";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectError, type ProjectErrorCode } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { parseReason, toExecutionResult } from "@/features/work-items/execution";
import { createClient } from "@/lib/supabase/server";

import { canUseReviewInbox } from "./logic";

export type ReviewDecision = "approve" | "reject";

export type ReviewDecisionResult =
  | { ok: true; changed: boolean; message: string }
  /** `handled`: the item is no longer awaiting review (decided elsewhere): drop it from the queue. */
  | { ok: false; error: string; code: ProjectErrorCode; handled: boolean };

const SUCCESS: Record<ReviewDecision, string> = {
  approve: "Approved. The item is done.",
  reject: "Changes requested. The item is back in progress.",
};

function failure(error: unknown): ReviewDecisionResult {
  if (!(error instanceof ProjectError)) throw error;
  const handled = error.code === "status_changed" || error.code === "invalid_transition" || error.code === "not_found";
  const message = error.code === "status_changed" ? "This review was already handled by someone else." : error.message;
  return { ok: false, error: message, code: error.code, handled };
}

/**
 * Approve (IN_REVIEW → DONE) or request changes (IN_REVIEW → IN_PROGRESS, with a
 * reason) through the Phase 8F2 execute_work_item function. The client sends
 * only the item id, the decision and the reason: project, role and permission
 * come from the session and the database. The expected status is always
 * IN_REVIEW, so a stale or concurrent decision fails with status_changed and a
 * retry of one that already succeeded is a no-op (changed = false).
 */
export async function decideReviewAction(input: { workItemId: string; decision: string; reason: string | null }): Promise<ReviewDecisionResult> {
  const { workItemId, decision } = input;
  if (!isUuid(workItemId)) return failure(new ProjectError("not_found"));
  if (decision !== "approve" && decision !== "reject") return failure(new ProjectError("invalid_action"));
  const reason = decision === "reject" ? parseReason(input.reason) : null;
  if (decision === "reject" && reason === null) return failure(new ProjectError("reason_required"));

  const { profile } = await requireActiveProfile();
  if (!canUseReviewInbox(profile.role)) return failure(new ProjectError("forbidden"));

  const client = await createClient();
  try {
    let response;
    try {
      response = await client.rpc("execute_work_item", {
        p_work_item_id: workItemId, p_action: decision, p_expected_status: "IN_REVIEW", p_reason: reason ?? undefined,
      });
    } catch {
      throw new ProjectError("unavailable");
    }
    if (response.error) failProject("execute_work_item", response.error);
    const rows = (response.data ?? []) as unknown[];
    if (rows.length !== 1) throw new ProjectError("unexpected");
    const item = toExecutionResult(rows[0]);
    revalidatePath("/reviews");
    return { ok: true, changed: item.changed, message: item.changed ? SUCCESS[decision] : "Already handled." };
  } catch (error) {
    return failure(error);
  }
}
