import "server-only";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectError } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { createClient } from "@/lib/supabase/server";

import { canUseReviewInbox, reviewQueueArgs, toReviewPage, toReviewSummary, totalFromRows, type ReviewPage, type ReviewQuery, type ReviewSummary } from "./logic";

/*
 * Server-only Review Inbox reads (Phase 8G1). One bounded RPC each; the
 * database decides the scope (SA: all projects, PM: assigned projects) and
 * refuses developers. The role check here only fails fast.
 */

async function reviewClient() {
  const { profile } = await requireActiveProfile();
  if (!canUseReviewInbox(profile.role)) throw new ProjectError("forbidden");
  return createClient();
}

export async function listReviewQueue(query: ReviewQuery): Promise<ReviewPage> {
  const supabase = await reviewClient();
  const { data, error } = await supabase.rpc("list_review_queue", reviewQueueArgs(query));
  if (error) failProject("list_review_queue", error);
  const rows: unknown[] = data ?? [];
  const asOf = Date.now();

  // A page past the end has no rows (and no count): probe once so the UI can
  // offer a way back instead of claiming the queue is empty.
  if (rows.length === 0 && query.page > 1) {
    const probe = await supabase.rpc("list_review_queue", { ...reviewQueueArgs(query), p_page: 1, p_page_size: 1 });
    if (probe.error) failProject("list_review_queue", probe.error);
    return toReviewPage(rows, query.page, asOf, totalFromRows(probe.data ?? []));
  }
  return toReviewPage(rows, query.page, asOf);
}

export async function getReviewSummary(): Promise<ReviewSummary> {
  const supabase = await reviewClient();
  const { data, error } = await supabase.rpc("review_queue_summary");
  if (error) failProject("review_queue_summary", error);
  return toReviewSummary(data ?? []);
}
