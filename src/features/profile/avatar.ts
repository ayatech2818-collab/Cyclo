import { safeAvatarUrl } from "@/features/employees/format";
import { isUuid } from "@/features/employees/validation";

import { isEmojiAvatarId, isIconAvatarId, type EmojiAvatarId, type IconAvatarId } from "./avatar-catalog";

/*
 * Avatar selection state and display resolution. Pure and framework-free.
 *
 * Display priority:
 *   1. uploaded image (kind "image" with a signed URL)
 *   2. emoji or icon (kind "emoji" / "icon")
 *   3. administrator-managed avatar_url (only while kind is "default")
 *   4. initials
 * "initials" is an explicit choice and therefore also hides avatar_url.
 */

export const AVATAR_KINDS = ["default", "initials", "image", "emoji", "icon"] as const;
export type AvatarKind = (typeof AVATAR_KINDS)[number];

export type AvatarState = {
  kind: AvatarKind;
  symbol: string | null;
  path: string | null;
  url: string | null;
};

export type ResolvedAvatar =
  | { type: "image"; src: string }
  | { type: "emoji"; id: EmojiAvatarId }
  | { type: "icon"; id: IconAvatarId }
  | { type: "url"; src: string }
  | { type: "initials" };

export class AvatarStateError extends Error {}

const PATH_PATTERN = /^([0-9a-f-]{36})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

/** True when path is "<ownerId>/<uuid>.<jpg|png|webp>" (mirrors profiles_avatar_path_valid). */
export function isAvatarPathFor(ownerId: string, path: unknown): path is string {
  if (typeof path !== "string") return false;
  const match = PATH_PATTERN.exec(path);
  return match !== null && match[1] === ownerId && isUuid(ownerId);
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new AvatarStateError("invalid avatar state");
  return value;
}

/** Strict parser for get_employee_avatars / set_my_avatar rows. Fails closed. */
export function toAvatarState(ownerId: string, value: unknown): AvatarState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AvatarStateError("invalid avatar state");
  const row = value as Record<string, unknown>;
  const kind = row.avatar_kind;
  if (typeof kind !== "string" || !(AVATAR_KINDS as readonly string[]).includes(kind)) throw new AvatarStateError("invalid avatar state");
  const symbol = nullableString(row.avatar_symbol);
  const path = nullableString(row.avatar_path);
  const url = nullableString(row.avatar_url);
  if (kind === "emoji" && !isEmojiAvatarId(symbol)) throw new AvatarStateError("invalid avatar state");
  if (kind === "icon" && !isIconAvatarId(symbol)) throw new AvatarStateError("invalid avatar state");
  if (path !== null && !isAvatarPathFor(ownerId, path)) throw new AvatarStateError("invalid avatar state");
  if (kind === "image" && path === null) throw new AvatarStateError("invalid avatar state");
  return { kind: kind as AvatarKind, symbol: kind === "emoji" || kind === "icon" ? symbol : null, path, url };
}

/** Applies the display priority. signedUrl is the server-created URL for state.path, if any. */
export function resolveAvatar(state: AvatarState | null, signedUrl: string | null): ResolvedAvatar {
  if (!state) return { type: "initials" };
  if (state.kind === "image" && signedUrl) return { type: "image", src: signedUrl };
  if (state.kind === "emoji" && isEmojiAvatarId(state.symbol)) return { type: "emoji", id: state.symbol };
  if (state.kind === "icon" && isIconAvatarId(state.symbol)) return { type: "icon", id: state.symbol };
  if (state.kind !== "initials") {
    const url = safeAvatarUrl(state.url);
    if (url) return { type: "url", src: url };
  }
  return { type: "initials" };
}

/**
 * Accepts a signed URL only when it points at this project's Storage sign
 * endpoint for the avatars bucket, so a malformed SDK response can never
 * place an arbitrary URL into an <img>.
 */
export function trustedSignedUrl(supabaseUrl: string, value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const base = new URL(supabaseUrl);
    const url = new URL(value);
    if (url.origin !== base.origin || !url.pathname.startsWith("/storage/v1/object/sign/avatars/")) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Upload validation
// ---------------------------------------------------------------------------

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export type AvatarImageType = { ext: "jpg" | "png" | "webp"; contentType: "image/jpeg" | "image/png" | "image/webp" };

/** Detects the real format from the file signature. The declared type and name are ignored. */
export function detectAvatarImage(bytes: Uint8Array): AvatarImageType | null {
  const at = (offset: number, signature: number[]) => signature.every((byte, i) => bytes[offset + i] === byte);
  if (bytes.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return { ext: "jpg", contentType: "image/jpeg" };
  if (bytes.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", contentType: "image/png" };
  if (bytes.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return { ext: "webp", contentType: "image/webp" };
  return null;
}

export type AvatarUploadCheck =
  | { ok: true; image: AvatarImageType }
  | { ok: false; reason: "missing" | "too_large" | "unsupported" };

export function checkAvatarUpload(size: number, bytes: Uint8Array): AvatarUploadCheck {
  if (size <= 0 || bytes.length === 0) return { ok: false, reason: "missing" };
  if (size > AVATAR_MAX_BYTES || bytes.length > AVATAR_MAX_BYTES) return { ok: false, reason: "too_large" };
  const image = detectAvatarImage(bytes);
  return image ? { ok: true, image } : { ok: false, reason: "unsupported" };
}
