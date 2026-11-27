"use client";

import { useEffect, useState, useTransition } from "react";
import { BellOff, CheckCheck, Loader2 } from "lucide-react";

import { useViewerClock } from "@/features/projects/components/project-activity";

import { loadFirstNotificationsAction, loadMoreNotificationsAction } from "../actions";
import { groupByDay, markRead, matchesFilter, mergeNotifications, type Notification, type NotificationPage, type NotificationQuery } from "../logic";
import { NotificationRow } from "./notification-row";
import { useNotifications } from "./notifications-provider";

/**
 * The /notifications list for one filter. New notifications that match the
 * filter appear live; reads in this or another tab update in place; a
 * reconnect re-reads the first page. Rows that stop matching "Unread" stay
 * until the next visit so the list does not jump under the pointer.
 */
export function NotificationsList({ query, initialPage }: { query: NotificationQuery; initialPage: NotificationPage }) {
  const { unread, fresh, markRead: markReadOnServer, markAllRead, subscribe } = useNotifications();
  const [items, setItems] = useState(initialPage.notifications);
  const [cursor, setCursor] = useState(initialPage.nextCursor);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const { now, timeZone } = useViewerClock();

  useEffect(() => subscribe({
    onChanged: (changed) => setItems((current) => {
      const known = new Set(current.map((entry) => entry.id));
      // Updates to rows on screen always apply; new rows only when they match this filter.
      const relevant = changed.filter((entry) => known.has(entry.id) || matchesFilter(entry, query.status, query.category));
      return relevant.length ? mergeNotifications(current, relevant) : current;
    }),
    onRead: (ids, at) => setItems((current) => markRead(current, ids, at)),
    onResync: () => {
      void loadFirstNotificationsAction(query.status, query.category)
        .then((result) => { if (result.ok) setItems((current) => mergeNotifications(current, result.value.notifications)); }, () => undefined);
    },
  }), [subscribe, query.status, query.category]);

  const loadMore = () => {
    if (!cursor) return;
    startLoading(async () => {
      const result = await loadMoreNotificationsAction(query.status, query.category, cursor).catch(() => null);
      if (!result?.ok) {
        setError(result?.error ?? "More notifications could not be loaded. Try again.");
        return;
      }
      setError(null);
      setItems((current) => mergeNotifications(current, result.value.notifications));
      setCursor(result.value.nextCursor);
    });
  };

  const groups = groupByDay(items, now ?? new Date(initialPage.notifications[0]?.createdAt ?? 0), timeZone);
  const open = (entry: Notification) => void markReadOnServer([entry]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-secondary" aria-live="polite">{unread === 0 ? "No unread notifications" : `${unread} unread`}</p>
        <button type="button" onClick={() => void markAllRead()} disabled={unread === 0}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60">
          <CheckCheck aria-hidden="true" className="size-4" />Mark all read
        </button>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-surface px-6 py-14 text-center">
          <span className="mb-4 rounded-full bg-primary/10 p-3 text-primary"><BellOff aria-hidden="true" className="size-6" /></span>
          <h2 className="text-base font-semibold">{query.status === "unread" ? "No unread notifications" : query.category || query.status === "read" ? "Nothing here" : "No notifications yet"}</h2>
          <p className="mt-1 max-w-sm text-sm text-text-secondary">Mentions, assignments, review decisions and comments on your work will appear here as they happen.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key} aria-labelledby={`day-${group.key}`}>
              <h2 id={`day-${group.key}`} className="mb-2 text-xs font-semibold tracking-wide text-text-muted uppercase">{group.label}</h2>
              <ul className="space-y-1 rounded-xl border border-border bg-surface p-1.5 shadow-sm">
                {group.notifications.map((entry) => (
                  <NotificationRow key={entry.id} notification={entry} now={now} timeZone={timeZone}
                    fresh={fresh.has(entry.id)} onOpen={open} onMarkRead={open} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {cursor && (
        <button type="button" onClick={loadMore} disabled={loading}
          className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface text-sm font-medium hover:bg-surface-muted disabled:opacity-60">
          {loading && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}Load more
        </button>
      )}
    </div>
  );
}
