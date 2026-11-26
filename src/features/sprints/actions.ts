"use server";

import { revalidatePath } from "next/cache";

import { requireActiveProfile } from "@/features/auth/server";
import { listBacklog } from "@/features/backlog/queries.server";
import { parseBacklogQuery } from "@/features/backlog/logic";
import type { BacklogItem } from "@/features/backlog/types";
import { ProjectError } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { createClient } from "@/lib/supabase/server";

import { parseCapacity, parseSelection, validateSprintFields } from "./logic";
import type { SprintFieldErrors } from "./types";

export type SprintActionResult = { error: string | null; fieldErrors: SprintFieldErrors; success: string | null; id?: string };

const ok = (success: string, id?: string): SprintActionResult => ({ error: null, fieldErrors: {}, success, id });

function fail(error: unknown): SprintActionResult {
  if (!(error instanceof ProjectError)) throw error; // redirects and unexpected errors propagate
  const field: keyof SprintFieldErrors | null =
    error.code === "invalid_sprint_name" ? "name"
      : error.code === "invalid_sprint_goal" ? "goal"
        : error.code === "invalid_sprint_dates" || error.code === "sprint_started" ? "endDate"
          : error.code === "invalid_capacity" ? "capacity" : null;
  return field ? { error: null, fieldErrors: { [field]: error.message }, success: null } : { error: error.message, fieldErrors: {}, success: null };
}

type RpcResult = { data: unknown; error: { code?: string | null; message?: string | null } | null };

/** Runs an RPC; maps database errors to safe messages. */
async function call(operation: string, run: (client: Awaited<ReturnType<typeof createClient>>) => PromiseLike<RpcResult>): Promise<unknown> {
  await requireActiveProfile();
  const client = await createClient();
  let result: RpcResult;
  try {
    result = await run(client);
  } catch {
    throw new ProjectError("unavailable");
  }
  if (result.error) failProject(operation, result.error);
  return result.data;
}

function revalidate(projectId: string, sprintId?: string) {
  revalidatePath(`/projects/${projectId}/sprints`);
  if (sprintId) revalidatePath(`/projects/${projectId}/sprints/${sprintId}`);
  revalidatePath(`/projects/${projectId}/backlog`);
  revalidatePath(`/projects/${projectId}/activity`);
}

function field(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

const ids = (projectId: string, sprintId?: string | null) => isUuid(projectId) && (sprintId === undefined || sprintId === null || isUuid(sprintId));

export async function createSprintAction(projectId: string, _state: SprintActionResult, data: FormData): Promise<SprintActionResult> {
  const parsed = validateSprintFields({ name: field(data, "name"), goal: field(data, "goal"), startDate: field(data, "startDate"), endDate: field(data, "endDate") }, { requireDates: false });
  const capacity = parseCapacity(field(data, "capacity"));
  if (!parsed.ok || capacity === "invalid") {
    return { error: "Please correct the highlighted fields.", fieldErrors: { ...(parsed.ok ? {} : parsed.errors), ...(capacity === "invalid" ? { capacity: "Use 0–10,000 points, with at most one decimal." } : {}) }, success: null };
  }
  if (!ids(projectId)) return fail(new ProjectError("not_found"));
  try {
    const id = await call("create_sprint", (client) => client.rpc("create_sprint", {
      p_project_id: projectId, p_name: parsed.values.name, p_goal: parsed.values.goal ?? undefined,
      p_start_date: parsed.values.startDate ?? undefined, p_end_date: parsed.values.endDate ?? undefined, p_capacity_points: capacity ?? undefined,
    }));
    if (!isUuid(id)) throw new ProjectError("unexpected");
    revalidate(projectId, id);
    return ok("Sprint created.", id);
  } catch (error) {
    return fail(error);
  }
}

export async function updateSprintAction(projectId: string, sprintId: string, active: boolean, _state: SprintActionResult, data: FormData): Promise<SprintActionResult> {
  const parsed = validateSprintFields({ name: field(data, "name"), goal: field(data, "goal"), startDate: field(data, "startDate"), endDate: field(data, "endDate") }, { requireDates: active });
  if (!parsed.ok) return { error: "Please correct the highlighted fields.", fieldErrors: parsed.errors, success: null };
  if (!ids(projectId, sprintId)) return fail(new ProjectError("not_found"));
  try {
    await call("update_sprint", (client) => client.rpc("update_sprint", {
      p_sprint_id: sprintId, p_name: parsed.values.name, p_goal: parsed.values.goal ?? undefined,
      p_start_date: parsed.values.startDate ?? undefined, p_end_date: parsed.values.endDate ?? undefined,
    }));
    revalidate(projectId, sprintId);
    return ok("Sprint updated.");
  } catch (error) {
    return fail(error);
  }
}

export async function setCapacityAction(projectId: string, sprintId: string, value: string): Promise<SprintActionResult> {
  const capacity = parseCapacity(value);
  if (capacity === "invalid") return { error: null, fieldErrors: { capacity: "Use 0–10,000 points, with at most one decimal." }, success: null };
  if (!ids(projectId, sprintId)) return fail(new ProjectError("not_found"));
  try {
    await call("set_sprint_capacity", (client) => client.rpc("set_sprint_capacity", { p_sprint_id: sprintId, p_capacity_points: capacity ?? undefined }));
    revalidate(projectId, sprintId);
    return ok(capacity === null ? "Capacity cleared." : "Capacity saved.");
  } catch (error) {
    return fail(error);
  }
}

type Membership = "add" | "remove";

export async function changeMembershipAction(projectId: string, sprintId: string, change: Membership, workItemIds: string[]): Promise<SprintActionResult> {
  const selection = parseSelection(workItemIds);
  if (!selection || !ids(projectId, sprintId)) return fail(new ProjectError("invalid_selection"));
  const name = change === "add" ? "add_work_items_to_sprint" : "remove_work_items_from_sprint";
  try {
    await call(name, (client) => client.rpc(name, { p_sprint_id: sprintId, p_work_item_ids: selection }));
    revalidate(projectId, sprintId);
    const noun = `${selection.length} item${selection.length === 1 ? "" : "s"}`;
    return ok(change === "add" ? `Added ${noun} to the sprint.` : `Returned ${noun} to the backlog.`);
  } catch (error) {
    return fail(error);
  }
}

export async function moveItemsAction(projectId: string, fromSprintId: string, toSprintId: string, workItemIds: string[]): Promise<SprintActionResult> {
  const selection = parseSelection(workItemIds);
  if (!selection || !ids(projectId, fromSprintId) || !isUuid(toSprintId)) return fail(new ProjectError("invalid_selection"));
  try {
    await call("move_work_items_between_sprints", (client) => client.rpc("move_work_items_between_sprints", {
      p_from_sprint_id: fromSprintId, p_to_sprint_id: toSprintId, p_work_item_ids: selection,
    }));
    revalidate(projectId, fromSprintId);
    revalidatePath(`/projects/${projectId}/sprints/${toSprintId}`);
    return ok(`Moved ${selection.length} item${selection.length === 1 ? "" : "s"}.`);
  } catch (error) {
    return fail(error);
  }
}

export async function startSprintAction(projectId: string, sprintId: string): Promise<SprintActionResult> {
  if (!ids(projectId, sprintId)) return fail(new ProjectError("not_found"));
  try {
    await call("start_sprint", (client) => client.rpc("start_sprint", { p_sprint_id: sprintId }));
    revalidate(projectId, sprintId);
    return ok("Sprint started.");
  } catch (error) {
    return fail(error);
  }
}

/** carryOver: "backlog" | "sprint" (with targetSprintId). Required by the database when work is unfinished. */
export async function completeSprintAction(projectId: string, sprintId: string, carryOver: string, targetSprintId: string | null): Promise<SprintActionResult> {
  if (!ids(projectId, sprintId) || (targetSprintId !== null && !isUuid(targetSprintId))) return fail(new ProjectError("not_found"));
  if (carryOver !== "backlog" && carryOver !== "sprint") return fail(new ProjectError("unfinished_work_requires_decision"));
  try {
    const carried = await call("complete_sprint", (client) => client.rpc("complete_sprint", {
      p_sprint_id: sprintId, p_carry_over: carryOver, p_target_sprint_id: carryOver === "sprint" ? (targetSprintId ?? undefined) : undefined,
    }));
    revalidate(projectId, sprintId);
    if (targetSprintId) revalidatePath(`/projects/${projectId}/sprints/${targetSprintId}`);
    const moved = typeof carried === "number" ? carried : 0;
    return ok(moved ? `Sprint completed. ${moved} unfinished item${moved === 1 ? "" : "s"} carried over.` : "Sprint completed.");
  } catch (error) {
    return fail(error);
  }
}

export async function cancelSprintAction(projectId: string, sprintId: string): Promise<SprintActionResult> {
  if (!ids(projectId, sprintId)) return fail(new ProjectError("not_found"));
  try {
    await call("cancel_sprint", (client) => client.rpc("cancel_sprint", { p_sprint_id: sprintId }));
    revalidate(projectId, sprintId);
    return ok("Sprint cancelled. Its items are back in the backlog.");
  } catch (error) {
    return fail(error);
  }
}

export type CandidateResult = { items: BacklogItem[]; total: number; error: string | null };

/** Eligible work = the backlog (open, unscheduled stories, tasks and bugs), searchable and paginated. */
export async function searchCandidatesAction(projectId: string, search: string, page: number): Promise<CandidateResult> {
  try {
    const query = parseBacklogQuery({ q: search, page: String(Math.max(1, Math.floor(page) || 1)), size: "25" });
    const result = await listBacklog(projectId, query);
    return { items: result.items, total: result.total, error: null };
  } catch (error) {
    if (!(error instanceof ProjectError)) throw error;
    return { items: [], total: 0, error: error.message };
  }
}
