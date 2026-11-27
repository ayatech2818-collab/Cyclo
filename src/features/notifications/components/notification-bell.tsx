"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, BellOff, CheckCheck, Loader2, Settings } from "lucide-react";

import { useViewerClock } from "@/features/projects/components/project-activity";
import { cn } from "@/lib/utils/cn";

import { badgeLabel, DROPDOWN_SIZE } from "../logic";
import { NotificationRow } from "./notification-row";
import { useNotifications } from "./notifications-provider";

/**
 * Header bell: unread badge (99+), and a dropdown with recent notifications.
 * Closes on outside click, Escape (focus returns to the bell) and navigation.
 */
export function NotificationBell() {
  const { unread, recent, recentState, live, fresh, loadRecent, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const pathname = usePathname();
  const [path, setPath] = useState(pathname);
  if (path !== pathname) {
    setPath(pathname);
    if (open) setOpen(false);
  }
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const { now, timeZone } = useViewerClock();
  const badge = badgeLabel(unread);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      setOpenedAt(new Date().toISOString());
      loadRecent();
    }
  };

  const items = recent.slice(0, DROPDOWN_SIZE);
  const label = unread === 0 ? "Notifications" : `Notifications, ${unread} unread`;

  return (
    <div className="relative">
      <button ref={button} type="button" onClick={toggle} aria-label={label} aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined}
        aria-haspopup="dialog" title="Notifications"
        className={cn("relative inline-flex size-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-muted hover:text-text-primary", open && "bg-surface-muted text-text-primary")}>
        <Bell aria-hidden="true" className="size-4.5" />
        {badge && (
          <span key={badge} aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[0.625rem] leading-none font-bold text-accent-foreground ring-2 ring-surface tabular-nums motion-safe:animate-[badge-pop_300ms_ease-out]">
            {badge}
          </span>
        )}
      </button>
      <span className="sr-only" aria-live="polite">{unread > 0 ? `${unread} unread notifications` : ""}</span>

      {open && (
        <div ref={panel} id={`${id}-panel`} role="dialog" aria-label="Notifications"
          className="fixed inset-x-2 top-16 z-40 flex max-h-[calc(100svh-5rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl sm:absolute sm:inset-x-auto sm:top-11 sm:right-0 sm:w-[26rem] sm:max-h-[32rem]">
          <header className="flex items-center gap-2 border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {unread > 0 && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent tabular-nums">{unread} new</span>}
            <span title={live === "live" ? "Live" : "Reconnecting"} className={cn("size-1.5 rounded-full", live === "live" ? "bg-success" : "animate-pulse bg-warning")}>
              <span className="sr-only">{live === "live" ? "Live" : "Reconnecting"}</span>
            </span>
            <button type="button" onClick={() => void markAllRead()} disabled={unread === 0}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 disabled:cursor-default disabled:text-text-muted disabled:hover:bg-transparent">
              <CheckCheck aria-hidden="true" className="size-3.5" />Mark all read
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
            {recentState === "loading" && items.length === 0 ? (
              <p className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-text-muted"><Loader2 aria-hidden="true" className="size-4 animate-spin" />Loading…</p>
            ) : recentState === "error" && items.length === 0 ? (
              <div role="alert" className="px-4 py-10 text-center text-sm">
                <p className="text-danger">Notifications could not be loaded.</p>
                <button type="button" onClick={loadRecent} className="mt-2 text-xs font-medium text-primary hover:underline">Try again</button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-10 text-center">
                <span className="mb-3 rounded-full bg-primary/10 p-2.5 text-primary"><BellOff aria-hidden="true" className="size-5" /></span>
                <p className="text-sm font-medium">You’re all caught up</p>
                <p className="mt-1 text-xs text-text-secondary">Mentions, assignments, reviews and comments on your work show up here.</p>
              </div>
            ) : (
              <ul className="space-y-0.5">
                {items.map((notification) => (
                  <NotificationRow key={notification.id} notification={notification} now={now} timeZone={timeZone} compact
                    fresh={fresh.has(notification.id) && openedAt !== null && notification.createdAt > openedAt}
                    onOpen={(entry) => { void markRead([entry]); setOpen(false); }}
                    onMarkRead={(entry) => void markRead([entry])} />
                ))}
              </ul>
            )}
          </div>

          <footer className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs">
            <Link href="/notifications" onClick={() => setOpen(false)} className="font-medium text-primary hover:underline">View all notifications</Link>
            <Link href="/notifications/settings" onClick={() => setOpen(false)} className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary">
              <Settings aria-hidden="true" className="size-3.5" />Settings
            </Link>
          </footer>
        </div>
      )}
    </div>
  );
}
