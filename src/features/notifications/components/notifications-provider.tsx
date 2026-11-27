"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isUuid } from "@/features/projects/validation";
import { createClient } from "@/lib/supabase/client";

import { loadRecentNotificationsAction, markAllNotificationsReadAction, markNotificationsReadAction, syncNotificationsAction } from "../actions";
import { DROPDOWN_SIZE, markRead, mergeNotifications, type Notification } from "../logic";

export type LiveStatus = "connecting" | "live" | "reconnecting";
type RecentState = "idle" | "loading" | "ready" | "error";

export type NotificationListener = {
  /** Created or changed notifications (already re-read from the server). */
  onChanged?: (notifications: Notification[]) => void;
  /** Marked read here or in another tab ("all" = everything). */
  onRead?: (ids: ReadonlySet<string> | "all", at: string) => void;
  /** The subscription was (re)established: anything could have been missed. */
  onResync?: () => void;
};

type NotificationsContextValue = {
  unread: number;
  recent: Notification[];
  recentState: RecentState;
  live: LiveStatus;
  /** Ids that arrived live in this session (for a subtle highlight). */
  fresh: ReadonlySet<string>;
  loadRecent: () => void;
  markRead: (notifications: readonly Pick<Notification, "id" | "readAt">[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  subscribe: (listener: NotificationListener) => () => void;
};

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

export function useNotifications(): NotificationsContextValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications must be used inside NotificationsProvider");
  return value;
}

const BATCH_DELAY = 150;

/**
 * One notifications subscription for the whole app (mounted in the dashboard
 * layout, keyed by user): Supabase Realtime Postgres Changes on
 * public.notifications filtered to recipient_id = the signed-in employee.
 * Realtime applies the table's RLS (recipient_id = auth.uid()) to every event,
 * so nobody receives another person's rows. Events are signals: changed rows
 * and the unread count are re-read through the server. PostgreSQL stays the
 * source of truth; the subscription ends on logout or user change (unmount).
 */
export function NotificationsProvider({ userId, initialUnread, children }: { userId: string; initialUnread: number; children: ReactNode }) {
  const [unread, setUnread] = useState(initialUnread);
  const [recent, setRecent] = useState<Notification[]>([]);
  const [recentState, setRecentState] = useState<RecentState>("idle");
  const [live, setLive] = useState<LiveStatus>("connecting");
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const listeners = useRef(new Set<NotificationListener>());
  const recentLoaded = useRef(false);
  const known = useRef(new Set<string>());

  const emit = useCallback(<K extends keyof NotificationListener>(key: K, ...args: Parameters<NonNullable<NotificationListener[K]>>) => {
    for (const listener of listeners.current) (listener[key] as ((...values: unknown[]) => void) | undefined)?.(...args);
  }, []);

  const subscribe = useCallback((listener: NotificationListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const loadRecent = useCallback(() => {
    setRecentState((state) => (state === "ready" ? state : "loading"));
    void loadRecentNotificationsAction().then((result) => {
      if (!result.ok) {
        setRecentState((state) => (state === "ready" ? state : "error"));
        return;
      }
      recentLoaded.current = true;
      result.value.page.notifications.forEach((entry) => known.current.add(entry.id));
      setRecent(result.value.page.notifications);
      setUnread(result.value.unread);
      setRecentState("ready");
    }, () => setRecentState((state) => (state === "ready" ? state : "error")));
  }, []);

  const apply = useCallback((notifications: Notification[], unreadCount: number) => {
    setUnread(unreadCount);
    if (notifications.length === 0) return;
    const arrived = notifications.filter((entry) => !known.current.has(entry.id)).map((entry) => entry.id);
    notifications.forEach((entry) => known.current.add(entry.id));
    if (arrived.length) setFresh((current) => new Set([...current, ...arrived]));
    if (recentLoaded.current) setRecent((current) => mergeNotifications(current, notifications).slice(0, DROPDOWN_SIZE * 3));
    emit("onChanged", notifications);
  }, [emit]);

  // --- Realtime ---------------------------------------------------------------
  useEffect(() => {
    const supabase = createClient();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();

    const sync = async (ids: string[]) => {
      let result;
      try {
        result = await syncNotificationsAction(ids);
      } catch {
        return; // the next (re)connect catches up
      }
      if (active && result.ok) apply(result.value.notifications, result.value.unread);
    };
    const flush = () => {
      timer = undefined;
      const ids = [...pending].slice(0, 50);
      ids.forEach((id) => pending.delete(id));
      if (ids.length) void sync(ids);
      if (pending.size) timer = setTimeout(flush, BATCH_DELAY);
    };

    const channel = supabase
      .channel(`notifications:${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `recipient_id=eq.${userId}` }, (payload) => {
        if (!active) return;
        const row = (payload.eventType === "DELETE" ? payload.old : payload.new) as { id?: unknown; recipient_id?: unknown };
        if (!isUuid(row?.id) || (payload.eventType !== "DELETE" && row.recipient_id !== userId)) return;
        pending.add(row.id.toLowerCase());
        if (!timer) timer = setTimeout(flush, BATCH_DELAY);
      })
      .on("system", {}, (payload: { extension?: string; status?: string }) => {
        if (!active || payload.extension !== "postgres_changes") return;
        if (payload.status !== "ok") {
          setLive("reconnecting");
          return;
        }
        setLive("live");
        // Catch up on anything missed while connecting or disconnected.
        void sync([]);
        if (recentLoaded.current) loadRecent();
        emit("onResync");
      });

    void supabase.realtime.setAuth().finally(() => {
      if (!active) return;
      channel.subscribe((state) => {
        if (active && (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED")) setLive("reconnecting");
      });
    });

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [userId, apply, emit, loadRecent]);

  // --- Mark read ----------------------------------------------------------------
  const markReadCallback = useCallback(async (notifications: readonly Pick<Notification, "id" | "readAt">[]) => {
    const unreadIds = notifications.filter((entry) => !entry.readAt).map((entry) => entry.id);
    if (unreadIds.length === 0) return;
    const at = new Date().toISOString();
    const ids = new Set(unreadIds);
    setUnread((count) => Math.max(0, count - unreadIds.length));
    setRecent((current) => markRead(current, ids, at));
    emit("onRead", ids, at);
    const result = await markNotificationsReadAction(unreadIds).catch(() => null);
    if (result?.ok) setUnread(result.value);
    else void syncNotificationsAction([]).then((sync) => sync.ok && setUnread(sync.value.unread));
  }, [emit]);

  const markAllRead = useCallback(async () => {
    const at = new Date().toISOString();
    setUnread(0);
    setRecent((current) => markRead(current, "all", at));
    emit("onRead", "all", at);
    const result = await markAllNotificationsReadAction().catch(() => null);
    if (!result?.ok) void syncNotificationsAction([]).then((sync) => sync.ok && setUnread(sync.value.unread));
  }, [emit]);

  const value = useMemo<NotificationsContextValue>(() => ({
    unread, recent, recentState, live, fresh, loadRecent, markRead: markReadCallback, markAllRead, subscribe,
  }), [unread, recent, recentState, live, fresh, loadRecent, markReadCallback, markAllRead, subscribe]);

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
