"use server";

import { revalidatePath } from "next/cache";

import { ProfileError } from "./errors";
import { removeAvatarImage, selectAvatar, updateMyName, uploadAvatar } from "./mutations.server";

export type ProfileFormState = { error: string | null; success: string | null };

async function perform(operation: () => Promise<void>, success: string): Promise<ProfileFormState> {
  try {
    await operation();
  } catch (error) {
    // Redirects (expired session) and unexpected errors propagate unchanged.
    if (!(error instanceof ProfileError)) throw error;
    return { error: error.message, success: null };
  }
  // The avatar appears in the header and the directory, so refresh every page.
  revalidatePath("/", "layout");
  return { error: null, success };
}

export async function updateNameAction(_state: ProfileFormState, data: FormData): Promise<ProfileFormState> {
  return perform(() => updateMyName(data.get("fullName")), "Name updated.");
}

export async function selectAvatarAction(_state: ProfileFormState, data: FormData): Promise<ProfileFormState> {
  return perform(() => selectAvatar(data.get("kind"), data.get("symbol")), "Avatar updated.");
}

export async function uploadAvatarAction(_state: ProfileFormState, data: FormData): Promise<ProfileFormState> {
  return perform(() => uploadAvatar(data.get("file")), "Photo uploaded.");
}

// useActionState passes (state, formData); neither is needed to remove the photo.
export async function removeAvatarImageAction(): Promise<ProfileFormState> {
  return perform(() => removeAvatarImage(), "Photo removed.");
}
