import "server-only";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectError } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { createClient } from "@/lib/supabase/server";

import { backlogTotal, toBacklogItem, toBacklogSummary } from "./logic";
import type { BacklogPage, BacklogQuery, BacklogSummary } from "./types";

/** One page of the backlog in rank order (one RPC; grouping is done in the query). */
export async function listBacklog(projectId: string, query: BacklogQuery): Promise<BacklogPage> {
  await requireActiveProfile();
  if (!isUuid(projectId)) throw new ProjectError("not_found");
  const supabase = await createClient();
  const fetchPage = (page: number, pageSize: number) =>
    supabase.rpc("list_backlog", {
      p_project_id: projectId,
      p_search: query.search || undefined,
      p_type: query.type ?? undefined,
      p_status: query.status ?? undefined,
      p_priority: query.priority ?? undefined,
      p_assignee_id: query.assignee.kind === "person" ? query.assignee.id : undefined,
      p_unassigned: query.assignee.kind === "unassigned",
      p_epic_id: query.epic.kind === "epic" ? query.epic.id : undefined,
      p_no_epic: query.epic.kind === "none",
      p_include_completed: query.includeCompleted,
      p_group: query.group,
      p_page: page,
      p_page_size: pageSize,
    });

  const { data, error } = await fetchPage(query.page, query.pageSize);
  if (error) failProject("list_backlog", error);
  const rows: unknown[] = data ?? [];
  let total = backlogTotal(rows);
  if (rows.length === 0 && query.page > 1) {
    const probe = await fetchPage(1, 1);
    if (probe.error) failProject("list_backlog", probe.error);
    total = backlogTotal(probe.data ?? []);
  }
  return { items: rows.map(toBacklogItem), total, page: query.page, pageSize: query.pageSize, pageCount: Math.max(1, Math.ceil(total / query.pageSize)) };
}

export async function getBacklogSummary(projectId: string): Promise<BacklogSummary> {
  await requireActiveProfile();
  if (!isUuid(projectId)) throw new ProjectError("not_found");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("backlog_summary", { p_project_id: projectId });
  if (error) failProject("backlog_summary", error);
  return toBacklogSummary(data ?? []);
}
