/** Safe, user-facing profile errors. Raw database, Storage or Auth messages never reach the UI. */
export type ProfileErrorCode =
  | "forbidden"
  | "invalid_full_name"
  | "invalid_avatar"
  | "image_missing"
  | "file_missing"
  | "file_too_large"
  | "file_unsupported"
  | "upload_failed"
  | "unavailable";

export const PROFILE_ERROR_MESSAGES: Record<ProfileErrorCode, string> = {
  forbidden: "You do not have permission to change this profile.",
  invalid_full_name: "Enter a name between 1 and 200 characters.",
  invalid_avatar: "Choose one of the available avatars.",
  image_missing: "Upload a photo first.",
  file_missing: "Choose an image to upload.",
  file_too_large: "The image must be 2 MB or smaller.",
  file_unsupported: "Use a JPEG, PNG or WebP image.",
  upload_failed: "The image could not be uploaded. Please try again.",
  unavailable: "Your profile is temporarily unavailable. Please try again.",
};

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  constructor(code: ProfileErrorCode) {
    super(PROFILE_ERROR_MESSAGES[code]);
    this.name = "ProfileError";
    this.code = code;
  }
}

/** Maps a PostgREST/Postgres error from the profile RPCs to a safe code. */
export function profileFailure(error: { code?: string | null; message?: string | null } | null | undefined): ProfileError {
  const message = error?.message ?? "";
  if (error?.code === "42501") return new ProfileError("forbidden");
  if (message === "invalid_full_name") return new ProfileError("invalid_full_name");
  if (message === "avatar_image_missing") return new ProfileError("image_missing");
  if (["invalid_avatar_kind", "invalid_avatar_symbol", "invalid_avatar_path", "avatar_object_missing"].includes(message)) {
    return new ProfileError("invalid_avatar");
  }
  return new ProfileError("unavailable");
}
