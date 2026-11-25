"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireActiveProfile } from "@/features/auth/server";

import { PROJECT_ERROR_FIELDS, ProjectError } from "./errors";
import { assignProjectManager, createProject, setProjectArchived, updateProject } from "./mutations.server";
import type { ProjectFieldErrors } from "./types";
import { validateCreateProject, validateUpdateProject } from "./validation";

export type ProjectFormState = { error: string | null; fieldErrors: ProjectFieldErrors; success: string | null };

const FORM_FIELDS = ["name", "projectKey", "description", "status", "priority", "startDate", "targetDate", "projectManagerId"] as const;

function formInput(data: FormData): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const name of FORM_FIELDS) {
    const value = data.get(name);
    if (typeof value === "string") input[name] = value;
  }
  return input;
}

/** Converts a known project error into form state; anything else (incl. redirects) propagates. */
function toFormState(error: unknown): ProjectFormState {
  if (!(error instanceof ProjectError)) throw error;
  const field = PROJECT_ERROR_FIELDS[error.code];
  return field
    ? { error: null, fieldErrors: { [field]: error.message }, success: null }
    : { error: error.message, fieldErrors: {}, success: null };
}

const invalidForm = (fieldErrors: ProjectFieldErrors): ProjectFormState => ({
  error: "Please correct the highlighted fields.",
  fieldErrors,
  success: null,
});

export async function createProjectAction(_state: ProjectFormState, data: FormData): Promise<ProjectFormState> {
  const { profile } = await requireActiveProfile();
  const parsed = validateCreateProject(formInput(data), { requireManager: profile.role === "SUPER_ADMIN" });
  if (!parsed.ok) return invalidForm(parsed.errors);

  let id: string;
  try {
    id = await createProject(parsed.values);
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath("/projects");
  redirect(`/projects/${id}`);
}

export async function updateProjectAction(id: string, _state: ProjectFormState, data: FormData): Promise<ProjectFormState> {
  const parsed = validateUpdateProject(formInput(data));
  if (!parsed.ok) return invalidForm(parsed.errors);

  try {
    await updateProject(id, parsed.values);
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath("/projects");
  revalidatePath(`/projects/${id}`);
  redirect(`/projects/${id}`);
}

export async function assignProjectManagerAction(id: string, _state: ProjectFormState, data: FormData): Promise<ProjectFormState> {
  const value = data.get("projectManagerId");
  try {
    await assignProjectManager(id, typeof value === "string" ? value : "");
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath("/projects");
  revalidatePath(`/projects/${id}`);
  return { error: null, fieldErrors: {}, success: "Project Manager updated." };
}

// Bound with (id, archived); useActionState's (state, formData) arguments are not needed.
export async function setProjectArchivedAction(id: string, archived: boolean): Promise<ProjectFormState> {
  try {
    await setProjectArchived(id, archived);
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath("/projects");
  revalidatePath(`/projects/${id}`);
  return { error: null, fieldErrors: {}, success: archived ? "Project archived." : "Project restored." };
}
