import "server-only";

import { cache } from "react";

import { requireActiveProfile } from "@/features/auth/server";
import { getSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

import { resolveAvatar, toAvatarState, trustedSignedUrl, type AvatarState, type ResolvedAvatar } from "./avatar";

/** Signed URLs are created per request with the caller's own session (Storage RLS applies). */
const SIGNED_URL_SECONDS = 60 * 60;

type Client = Awaited<ReturnType<typeof createClient>>;

async function readStates(client: Client, ids: readonly string[]): Promise<Map<string, AvatarState>> {
  const states = new Map<string, AvatarState>();
  if (ids.length === 0) return states;
  const { data, error } = await client.rpc("get_employee_avatars", { p_employee_ids: [...ids] });
  if (error) {
    console.error(`[profile] get_employee_avatars failed: code=${error.code || "unknown"}`);
    return states;
  }
  for (const row of (data ?? []) as unknown[]) {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !ids.includes(id)) continue;
    try {
      states.set(id, toAvatarState(id, row));
    } catch {
      console.error("[profile] get_employee_avatars returned an invalid row");
    }
  }
  return states;
}

async function signPaths(client: Client, paths: readonly string[]): Promise<Map<string, string>> {
  const signed = new Map<string, string>();
  if (paths.length === 0) return signed;
  const { data, error } = await client.storage.from("avatars").createSignedUrls([...paths], SIGNED_URL_SECONDS);
  if (error || !data) {
    console.error("[profile] avatar signing failed");
    return signed;
  }
  const { url } = getSupabaseEnv();
  for (const item of data) {
    const src = item.error ? null : trustedSignedUrl(url, item.signedUrl);
    if (item.path && src) signed.set(item.path, src);
  }
  return signed;
}

/**
 * Resolved avatars for the given employees. Avatars are decorative: on any
 * failure the caller gets an empty map and renders the fallback.
 * The database decides which ids the caller may see (SA/PM: any; others: self).
 */
export async function loadAvatars(ids: readonly string[]): Promise<Map<string, ResolvedAvatar>> {
  const unique = [...new Set(ids)].slice(0, 100);
  const client = await createClient();
  const states = await readStates(client, unique);
  const imagePaths = [...states.values()].flatMap((s) => (s.kind === "image" && s.path ? [s.path] : []));
  const signed = await signPaths(client, imagePaths);
  const resolved = new Map<string, ResolvedAvatar>();
  for (const [id, state] of states) resolved.set(id, resolveAvatar(state, state.path ? signed.get(state.path) ?? null : null));
  return resolved;
}

/** The signed-in employee's resolved avatar, memoized per request (header + pages). */
export const getMyResolvedAvatar = cache(async (): Promise<ResolvedAvatar | null> => {
  const { profile } = await requireActiveProfile();
  return (await loadAvatars([profile.id])).get(profile.id) ?? null;
});

export type MyAvatarDetails = {
  state: AvatarState | null;
  resolved: ResolvedAvatar;
  /** Signed preview of the uploaded photo, even when another avatar is selected. */
  photoSrc: string | null;
};

/** Full avatar state for the profile page. */
export async function getMyAvatarDetails(): Promise<MyAvatarDetails> {
  const { profile } = await requireActiveProfile();
  const client = await createClient();
  const state = (await readStates(client, [profile.id])).get(profile.id) ?? null;
  const photoSrc = state?.path ? (await signPaths(client, [state.path])).get(state.path) ?? null : null;
  return { state, resolved: resolveAvatar(state, photoSrc), photoSrc };
}
