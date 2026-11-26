import "server-only";

import type { ProjectPriority } from "@/features/projects/types";
import { requireActiveProfile } from "@/features/auth/server";
import { ProjectError } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { createClient } from "@/lib/supabase/server";

import type { CreateWorkItemValues, WorkItemContentValues, WorkItemStatus, WorkItemType } from "./types";

/*
 * Server-only work item writes. The actor (and reporter) always comes from the
 * verified session inside the database; no identity or role is ever sent.
 */

type RpcResult = { data: unknown; error: { code?: string | null; message?: string | null } | null };

async function rpcId(operation: string, call: () => PromiseLike<RpcResult>): Promise<string> {
  await requireActiveProfile();
  let result: RpcResult;
  try {
    result = await call();
  } catch {
    throw new ProjectError("unavailable");
  }
  if (result.error) failProject(operation, result.error);
  if (!isUuid(result.data)) throw new ProjectError("unexpected");
  return result.data;
}

function requireId(id: string) {
  if (!isUuid(id)) throw new ProjectError("not_found");
}

export async function createWorkItem(projectId: string, values: CreateWorkItemValues): Promise<string> {
  requireId(projectId);
  const supabase = await createClient();
  return rpcId("create_work_item", () =>
    supabase.rpc("create_work_item", {
      p_project_id: projectId,
      p_type: values.type,
      p_title: values.title,
      p_description: values.description ?? undefined,
      p_parent_id: values.parentId ?? undefined,
      p_status: values.status,
      p_priority: values.priority,
      p_assignee_id: values.assigneeId ?? undefined,
      p_start_date: values.startDate ?? undefined,
      p_due_date: values.dueDate ?? undefined,
      p_estimate: values.estimate ?? undefined,
    }),
  );
}

export async function updateWorkItem(id: string, values: WorkItemContentValues): Promise<string> {
  requireId(id);
  const supabase = await createClient();
  return rpcId("update_work_item", () =>
    supabase.rpc("update_work_item", {
      p_work_item_id: id,
      p_title: values.title,
      p_description: values.description ?? undefined,
      p_start_date: values.startDate ?? undefined,
      p_due_date: values.dueDate ?? undefined,
      p_estimate: values.estimate ?? undefined,
    }),
  );
}

export async function changeWorkItemStatus(id: string, status: WorkItemStatus): Promise<string> {
  requireId(id);
  const supabase = await createClient();
  return rpcId("change_work_item_status", () => supabase.rpc("change_work_item_status", { p_work_item_id: id, p_status: status }));
}

export async function assignWorkItem(id: string, assigneeId: string | null): Promise<string> {
  requireId(id);
  if (assigneeId !== null && !isUuid(assigneeId)) throw new ProjectError("invalid_assignee");
  const supabase = await createClient();
  return rpcId("assign_work_item", () =>
    supabase.rpc("assign_work_item", { p_work_item_id: id, p_assignee_id: assigneeId ?? undefined }),
  );
}

export async function changeWorkItemPriority(id: string, priority: ProjectPriority): Promise<string> {
  requireId(id);
  const supabase = await createClient();
  return rpcId("change_work_item_priority", () => supabase.rpc("change_work_item_priority", { p_work_item_id: id, p_priority: priority }));
}

export async function setWorkItemHierarchy(id: string, type: WorkItemType, parentId: string | null): Promise<string> {
  requireId(id);
  if (parentId !== null && !isUuid(parentId)) throw new ProjectError("invalid_parent");
  const supabase = await createClient();
  return rpcId("set_work_item_hierarchy", () =>
    supabase.rpc("set_work_item_hierarchy", { p_work_item_id: id, p_type: type, p_parent_id: parentId ?? undefined }),
  );
}

export async function setWorkItemArchived(id: string, archived: boolean): Promise<string> {
  requireId(id);
  const supabase = await createClient();
  const name = archived ? "archive_work_item" : "restore_work_item";
  return rpcId(name, () => supabase.rpc(name, { p_work_item_id: id }));
}
