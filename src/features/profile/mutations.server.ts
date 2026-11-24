import "server-only";

import { requireActiveProfile } from "@/features/auth/server";
import { createClient } from "@/lib/supabase/server";

import { AVATAR_KINDS, checkAvatarUpload, isAvatarPathFor, type AvatarKind } from "./avatar";
import { isEmojiAvatarId, isIconAvatarId } from "./avatar-catalog";
import { ProfileError, profileFailure } from "./errors";

/*
 * Self-service profile writes. Every write uses the caller's own session; the
 * RPCs take no employee id and re-check the caller in the database. Role,
 * status, employee code, Git Organizer and email are never touched here.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

/** Best effort: an orphaned object is harmless (private, caller-owned) but is cleaned when possible. */
async function removeObject(client: Client, ownerId: string, path: unknown) {
  if (!isAvatarPathFor(ownerId, path)) return;
  const { error } = await client.storage.from("avatars").remove([path]);
  if (error) console.error("[profile] previous avatar object could not be removed");
}

function previousPath(data: unknown): unknown {
  return Array.isArray(data) ? (data[0] as { previous_path?: unknown } | undefined)?.previous_path : undefined;
}

export async function updateMyName(fullName: unknown): Promise<void> {
  await requireActiveProfile();
  if (typeof fullName !== "string") throw new ProfileError("invalid_full_name");
  const trimmed = fullName.trim();
  if (trimmed.length < 1 || [...trimmed].length > 200) throw new ProfileError("invalid_full_name");
  const client = await createClient();
  const { error } = await client.rpc("update_my_profile", { p_full_name: trimmed });
  if (error) throw profileFailure(error);
}

export async function selectAvatar(kind: unknown, symbol: unknown): Promise<void> {
  const { profile } = await requireActiveProfile();
  if (typeof kind !== "string" || !(AVATAR_KINDS as readonly string[]).includes(kind)) throw new ProfileError("invalid_avatar");
  const avatarKind = kind as AvatarKind;
  let avatarSymbol: string | undefined;
  if (avatarKind === "emoji") {
    if (!isEmojiAvatarId(symbol)) throw new ProfileError("invalid_avatar");
    avatarSymbol = symbol;
  } else if (avatarKind === "icon") {
    if (!isIconAvatarId(symbol)) throw new ProfileError("invalid_avatar");
    avatarSymbol = symbol;
  } else if (symbol !== null && symbol !== undefined && symbol !== "") {
    throw new ProfileError("invalid_avatar");
  }
  const client = await createClient();
  const { data, error } = await client.rpc("set_my_avatar", { p_kind: avatarKind, p_symbol: avatarSymbol });
  if (error) throw profileFailure(error);
  await removeObject(client, profile.id, previousPath(data));
}

export async function uploadAvatar(file: unknown): Promise<void> {
  const { profile } = await requireActiveProfile();
  if (!(file instanceof File)) throw new ProfileError("file_missing");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkAvatarUpload(file.size, bytes);
  if (!check.ok) {
    throw new ProfileError(check.reason === "missing" ? "file_missing" : check.reason === "too_large" ? "file_too_large" : "file_unsupported");
  }
  // The object name is generated here; nothing from the client (name, type) is used.
  const path = `${profile.id}/${crypto.randomUUID()}.${check.image.ext}`;
  const client = await createClient();
  const upload = await client.storage.from("avatars").upload(path, bytes, {
    contentType: check.image.contentType,
    cacheControl: "3600",
    upsert: false,
  });
  if (upload.error) {
    console.error("[profile] avatar upload rejected by Storage");
    throw new ProfileError("upload_failed");
  }
  const { data, error } = await client.rpc("set_my_avatar_image", { p_path: path });
  if (error) {
    await removeObject(client, profile.id, path);
    throw profileFailure(error);
  }
  await removeObject(client, profile.id, previousPath(data));
}

export async function removeAvatarImage(): Promise<void> {
  const { profile } = await requireActiveProfile();
  const client = await createClient();
  const { data, error } = await client.rpc("remove_my_avatar_image");
  if (error) throw profileFailure(error);
  await removeObject(client, profile.id, previousPath(data));
}
