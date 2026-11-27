import "server-only";

import { requireActiveProfile } from "@/features/auth/server";
import { loadAvatars } from "@/features/profile/avatars.server";
import { ProjectError } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { createClient } from "@/lib/supabase/server";

import {
  NOTIFICATION_CATEGORIES, NOTIFICATION_PAGE_SIZE, toNotification, toNotificationPage,
  type Notification, type NotificationCategory, type NotificationCursor, type NotificationPage, type NotificationStatus,
} from "./logic";

/*
 * Server-only notification reads (Phase 8G3). Every RPC works on the signed-in
 * employee's own notifications; recipient ids never come from the client.
 */

async function client() {
  await requireActiveProfile();
  return createClient();
}

async function toNotifications(rows: readonly unknown[]): Promise<Notification[]> {
  const actorIds = rows.flatMap((row) => {
    const actor = (row as { actor_id?: unknown } | null)?.actor_id;
    return isUuid(actor) ? [actor] : [];
  });
  // Decorative: on any failure loadAvatars returns an empty map (one batched read, no N+1).
  const avatars = await loadAvatars(actorIds);
  return rows.map((row) => toNotification(row, avatars));
}

export async function listNotifications(
  status: NotificationStatus, category: NotificationCategory | null, cursor: NotificationCursor | null = null, pageSize = NOTIFICATION_PAGE_SIZE,
): Promise<NotificationPage> {
  const supabase = await client();
  const { data, error } = await supabase.rpc("list_notifications", {
    p_status: status, p_category: category ?? undefined, p_before_created_at: cursor?.createdAt, p_before_id: cursor?.id, p_limit: pageSize + 1,
  });
  if (error) failProject("list_notifications", error);
  return toNotificationPage(await toNotifications(data ?? []), pageSize);
}

export async function getNotificationsByIds(ids: readonly string[]): Promise<Notification[]> {
  if (ids.length === 0 || ids.length > 50 || !ids.every(isUuid)) throw new ProjectError("invalid_input");
  const supabase = await client();
  const { data, error } = await supabase.rpc("get_notifications", { p_ids: [...new Set(ids)] });
  if (error) failProject("get_notifications", error);
  return toNotifications(data ?? []);
}

export async function getUnreadCount(): Promise<number> {
  const supabase = await client();
  const { data, error } = await supabase.rpc("notification_unread_count");
  if (error) failProject("notification_unread_count", error);
  if (typeof data !== "number" || !Number.isInteger(data) || data < 0) throw new ProjectError("unexpected");
  return data;
}

export type NotificationPreference = { category: NotificationCategory; inApp: boolean };

export async function getNotificationPreferences(): Promise<NotificationPreference[]> {
  const supabase = await client();
  const { data, error } = await supabase.rpc("get_notification_preferences");
  if (error) failProject("get_notification_preferences", error);
  return ((data ?? []) as { category: unknown; in_app: unknown }[]).map((row) => {
    if (!(NOTIFICATION_CATEGORIES as readonly unknown[]).includes(row.category) || typeof row.in_app !== "boolean") throw new ProjectError("unexpected");
    return { category: row.category as NotificationCategory, inApp: row.in_app };
  });
}
