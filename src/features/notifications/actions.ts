"use server";

import { revalidatePath } from "next/cache";

import { requireActiveProfile } from "@/features/auth/server";
import { ProjectError } from "@/features/projects/errors";
import { failProject } from "@/features/projects/queries.server";
import { isUuid } from "@/features/projects/validation";
import { createClient } from "@/lib/supabase/server";

import { DROPDOWN_SIZE, isNotificationCategory, isNotificationCursor, type Notification, type NotificationPage } from "./logic";
import { getNotificationsByIds, getUnreadCount, listNotifications } from "./queries.server";

/*
 * Notification Server Actions (Phase 8G3). They act only on the signed-in
 * employee's own notifications; ids from the client are filtered by the
 * database to the caller's rows.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  if (!(error instanceof ProjectError)) throw error;
  return { ok: false, error: error.message };
}

const STATUSES = ["all", "unread", "read"] as const;

/** Recent notifications for the bell, plus the authoritative unread count. */
export async function loadRecentNotificationsAction(): Promise<Result<{ page: NotificationPage; unread: number }>> {
  try {
    const [page, unread] = await Promise.all([listNotifications("all", null, null, DROPDOWN_SIZE), getUnreadCount()]);
    return { ok: true, value: { page, unread } };
  } catch (error) {
    return failure(error);
  }
}

/** First page for a filter (after a reconnect). */
export async function loadFirstNotificationsAction(status: unknown, category: unknown): Promise<Result<NotificationPage>> {
  if (!(STATUSES as readonly unknown[]).includes(status) || (category !== null && !isNotificationCategory(category))) {
    return { ok: false, error: "That filter is not available." };
  }
  try {
    return { ok: true, value: await listNotifications(status as (typeof STATUSES)[number], category) };
  } catch (error) {
    return failure(error);
  }
}

export async function loadMoreNotificationsAction(status: unknown, category: unknown, cursor: unknown): Promise<Result<NotificationPage>> {
  if (!(STATUSES as readonly unknown[]).includes(status) || (category !== null && !isNotificationCategory(category)) || !isNotificationCursor(cursor)) {
    return { ok: false, error: "The list could not be continued. Reload the page." };
  }
  try {
    return { ok: true, value: await listNotifications(status as (typeof STATUSES)[number], category, cursor) };
  } catch (error) {
    return failure(error);
  }
}

/** Live updates: re-reads notifications a Realtime event pointed at, plus the unread count. */
export async function syncNotificationsAction(ids: unknown): Promise<Result<{ notifications: Notification[]; unread: number }>> {
  const list = Array.isArray(ids) ? ids.filter(isUuid).slice(0, 50) : [];
  try {
    const [notifications, unread] = await Promise.all([list.length ? getNotificationsByIds(list) : Promise.resolve([]), getUnreadCount()]);
    return { ok: true, value: { notifications, unread } };
  } catch (error) {
    return failure(error);
  }
}

export async function markNotificationsReadAction(ids: unknown): Promise<Result<number>> {
  const list = Array.isArray(ids) ? ids.filter(isUuid).slice(0, 100) : [];
  if (list.length === 0) return { ok: false, error: "Nothing to mark as read." };
  await requireActiveProfile();
  const supabase = await createClient();
  try {
    const { data, error } = await supabase.rpc("mark_notifications_read", { p_ids: list });
    if (error) failProject("mark_notifications_read", error);
    return { ok: true, value: typeof data === "number" ? data : 0 };
  } catch (error) {
    return failure(error);
  }
}

export async function markAllNotificationsReadAction(): Promise<Result<number>> {
  await requireActiveProfile();
  const supabase = await createClient();
  try {
    const { error } = await supabase.rpc("mark_all_notifications_read");
    if (error) failProject("mark_all_notifications_read", error);
    return { ok: true, value: 0 };
  } catch (error) {
    return failure(error);
  }
}

export async function setNotificationPreferenceAction(category: unknown, inApp: unknown): Promise<Result<null>> {
  if (!isNotificationCategory(category) || typeof inApp !== "boolean") return { ok: false, error: "That setting is not available." };
  await requireActiveProfile();
  const supabase = await createClient();
  try {
    const { error } = await supabase.rpc("set_notification_preference", { p_category: category, p_in_app: inApp });
    if (error) failProject("set_notification_preference", error);
    revalidatePath("/notifications/settings");
    return { ok: true, value: null };
  } catch (error) {
    return failure(error);
  }
}
