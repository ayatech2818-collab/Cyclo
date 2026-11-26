"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectError } from "@/features/projects/errors";
import { getProject } from "@/features/projects/queries.server";
import { isProjectPriority, isUuid } from "@/features/projects/validation";

import {
  assignWorkItem,
  changeWorkItemPriority,
  changeWorkItemStatus,
  createWorkItem,
  setWorkItemArchived,
  setWorkItemHierarchy,
  updateWorkItem,
} from "./mutations.server";
import { searchParentOptions } from "./queries.server";
import type { ParentOption, WorkItemField, WorkItemFieldErrors } from "./types";
import { creatableTypes, isWorkItemStatus, isWorkItemType, isWorkManager, validateCreateWorkItem, validateWorkItemContent } from "./validation";

export type WorkItemFormState = { error: string | null; fieldErrors: WorkItemFieldErrors; success: string | null };

const FIELD_FOR_CODE: Partial<Record<ProjectError["code"], WorkItemField>> = {
  invalid_type: "type",
  invalid_title: "title",
  invalid_description: "description",
  invalid_parent: "parentId",
  parent_archived: "parentId",
  invalid_assignee: "assigneeId",
  invalid_estimate: "estimate",
  invalid_date_range: "dueDate",
  invalid_status: "status",
  invalid_priority: "priority",
};

const FORM_FIELDS = ["type", "title", "description", "parentId", "status", "priority", "assigneeId", "startDate", "dueDate", "estimate"] as const;

function formInput(data: FormData): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const name of FORM_FIELDS) {
    const value = data.get(name);
    if (typeof value === "string") input[name] = value;
  }
  return input;
}

function toFormState(error: unknown): WorkItemFormState {
  if (!(error instanceof ProjectError)) throw error; // redirects and unexpected errors propagate
  const field = FIELD_FOR_CODE[error.code];
  return field ? { error: null, fieldErrors: { [field]: error.message }, success: null } : { error: error.message, fieldErrors: {}, success: null };
}

const invalid = (fieldErrors: WorkItemFieldErrors): WorkItemFormState => ({ error: "Please correct the highlighted fields.", fieldErrors, success: null });
const ok = (success: string): WorkItemFormState => ({ error: null, fieldErrors: {}, success });

function revalidateWork(projectId: string, workItemId?: string) {
  revalidatePath(`/projects/${projectId}/work`);
  revalidatePath(`/projects/${projectId}/activity`);
  if (workItemId) revalidatePath(`/projects/${projectId}/work/${workItemId}`);
}

export async function createWorkItemAction(projectId: string, _state: WorkItemFormState, data: FormData): Promise<WorkItemFormState> {
  const { profile } = await requireActiveProfile();
  if (!isUuid(projectId)) return toFormState(new ProjectError("not_found"));
  let project;
  try {
    project = await getProject(projectId);
  } catch (error) {
    return toFormState(error);
  }
  if (!project) return toFormState(new ProjectError("not_found"));
  const isManager = isWorkManager(profile, project);
  const parsed = validateCreateWorkItem(formInput(data), {
    allowedTypes: creatableTypes(isManager, profile.role),
    isManager,
    selfId: profile.id,
  });
  if (!parsed.ok) return invalid(parsed.errors);

  let id: string;
  try {
    id = await createWorkItem(projectId, parsed.values);
  } catch (error) {
    return toFormState(error);
  }
  revalidateWork(projectId);
  redirect(`/projects/${projectId}/work/${id}`);
}

export async function updateWorkItemAction(projectId: string, id: string, _state: WorkItemFormState, data: FormData): Promise<WorkItemFormState> {
  const parsed = validateWorkItemContent(formInput(data));
  if (!parsed.ok) return invalid(parsed.errors);
  try {
    await updateWorkItem(id, parsed.values);
  } catch (error) {
    return toFormState(error);
  }
  revalidateWork(projectId, id);
  return ok("Changes saved.");
}

/** Single-value controls (status, priority, assignee) call these directly. */
export async function changeStatusAction(projectId: string, id: string, status: string): Promise<WorkItemFormState> {
  if (!isWorkItemStatus(status)) return toFormState(new ProjectError("invalid_status"));
  try {
    await changeWorkItemStatus(id, status);
  } catch (error) {
    return toFormState(error);
  }
  revalidateWork(projectId, id);
  return ok("Status updated.");
}

export async function changePriorityAction(projectId: string, id: string, priority: string): Promise<WorkItemFormState> {
  if (!isProjectPriority(priority)) return toFormState(new ProjectError("invalid_priority"));
  try {
    await changeWorkItemPriority(id, priority);
  } catch (error) {
    return toFormState(error);
  }
  revalidateWork(projectId, id);
  return ok("Priority updated.");
}

export async function assignAction(projectId: string, id: string, assigneeId: string): Promise<WorkItemFormState> {
  try {
    await assignWorkItem(id, assigneeId === "" ? null : assigneeId);
  } catch (error) {
    return toFormState(error);
  }
  revalidateWork(projectId, id);
  return ok(assigneeId === "" ? "Unassigned." : "Assignee updated.");
}

export async function setHierarchyAction(projectId: string, id: string, type: string, parentId: string | null): Promise<WorkItemFormState> {
  if (!isWorkItemType(type)) return toFormState(new ProjectError("invalid_type"));
  try {
    await setWorkItemHierarchy(id, type, parentId || null);
  } catch (error) {
    return toFormState(error);
  }
  revalidateWork(projectId, id);
  return ok("Type and parent updated.");
}

export async function setArchivedAction(projectId: string, id: string, archived: boolean): Promise<WorkItemFormState> {
  try {
    await setWorkItemArchived(id, archived);
  } catch (error) {
    return toFormState(error);
  }
  revalidateWork(projectId, id);
  return ok(archived ? "Work item archived." : "Work item restored.");
}

export type ParentSearchResult = { options: ParentOption[]; error: string | null };

export async function searchParentsAction(projectId: string, childType: string, search: string, excludeId: string | null): Promise<ParentSearchResult> {
  if (!isWorkItemType(childType)) return { options: [], error: null };
  try {
    return { options: await searchParentOptions(projectId, childType, search, excludeId), error: null };
  } catch (error) {
    if (!(error instanceof ProjectError)) throw error;
    return { options: [], error: error.message };
  }
}
