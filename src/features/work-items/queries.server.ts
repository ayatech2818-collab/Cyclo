import "server-only";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectError } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { isUuid, normalizeSearch } from "@/features/projects/validation";
import { createClient } from "@/lib/supabase/server";

import { toParentOption, toWorkItemChild, toWorkItemDetail, toWorkItemListItem, workItemTotal } from "./dto";
import type { ParentOption, WorkItemChild, WorkItemDetail, WorkItemListPage, WorkItemListQuery, WorkItemType } from "./types";

/*
 * Server-only work item reads. Visibility (SA, assigned PM, member developer)
 * is decided by the database; each page is one RPC call (no N+1).
 */

export async function listWorkItems(projectId: string, query: WorkItemListQuery): Promise<WorkItemListPage> {
  await requireActiveProfile();
  if (!isUuid(projectId)) throw new ProjectError("not_found");
  const supabase = await createClient();

  const fetchPage = (page: number, pageSize: number) =>
    supabase.rpc("list_work_items", {
      p_project_id: projectId,
      p_search: query.search || undefined,
      p_type: query.type ?? undefined,
      p_status: query.status ?? undefined,
      p_priority: query.priority ?? undefined,
      p_assignee_id: query.assignee.kind === "person" ? query.assignee.id : undefined,
      p_unassigned: query.assignee.kind === "unassigned",
      p_archived: query.archived,
      p_sort: query.sort,
      p_page: page,
      p_page_size: pageSize,
    });

  const { data, error } = await fetchPage(query.page, query.pageSize);
  if (error) failProject("list_work_items", error);
  const rows: unknown[] = data ?? [];
  let total = workItemTotal(rows);
  if (rows.length === 0 && query.page > 1) {
    const probe = await fetchPage(1, 1);
    if (probe.error) failProject("list_work_items", probe.error);
    total = workItemTotal(probe.data ?? []);
  }
  return {
    items: rows.map(toWorkItemListItem),
    total,
    page: query.page,
    pageSize: query.pageSize,
    pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/** Null when missing or not visible to the caller. */
export async function getWorkItem(workItemId: string): Promise<WorkItemDetail | null> {
  await requireActiveProfile();
  if (!isUuid(workItemId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_work_item", { p_work_item_id: workItemId });
  if (error) failProject("get_work_item", error);
  const rows: unknown[] = data ?? [];
  return rows.length ? toWorkItemDetail(rows[0]) : null;
}

export async function listWorkItemChildren(workItemId: string): Promise<WorkItemChild[]> {
  await requireActiveProfile();
  if (!isUuid(workItemId)) throw new ProjectError("not_found");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_work_item_children", { p_work_item_id: workItemId });
  if (error) failProject("list_work_item_children", error);
  return ((data ?? []) as unknown[]).map(toWorkItemChild);
}

export const PARENT_OPTION_LIMIT = 20;

export async function searchParentOptions(projectId: string, childType: WorkItemType, search: unknown, excludeId: string | null): Promise<ParentOption[]> {
  await requireActiveProfile();
  if (!isUuid(projectId)) throw new ProjectError("not_found");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_work_item_parent_options", {
    p_project_id: projectId,
    p_child_type: childType,
    p_search: normalizeSearch(search) || undefined,
    p_exclude_id: excludeId && isUuid(excludeId) ? excludeId : undefined,
    p_limit: PARENT_OPTION_LIMIT,
  });
  if (error) failProject("list_work_item_parent_options", error);
  return ((data ?? []) as unknown[]).map(toParentOption);
}
