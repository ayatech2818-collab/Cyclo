import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, Settings } from "lucide-react";

import { StatePanel, secondaryButton } from "@/features/employees/components/state-panel";
import { NotificationsList } from "@/features/notifications/components/notifications-list";
import { CATEGORY_LABELS, NOTIFICATION_CATEGORIES, notificationsHref, parseNotificationQuery } from "@/features/notifications/logic";
import { listNotifications } from "@/features/notifications/queries.server";
import { PROJECT_ERROR_MESSAGES } from "@/features/projects/errors";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Notifications | CYCLO" };

const chip = "inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-xs font-medium whitespace-nowrap";

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = parseNotificationQuery(await searchParams);
  // Only the signed-in employee's own notifications (decided by the database).
  const page = await loadProjectForPage(() => listNotifications(query.status, query.category));

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Notifications</h1>
          <p className="text-sm text-text-secondary">Mentions, assignments, reviews and discussion on your work.</p>
        </div>
        <Link href="/notifications/settings" className={cn(secondaryButton, "gap-1.5")}><Settings aria-hidden="true" className="size-4" />Settings</Link>
      </header>

      <nav aria-label="Filter notifications" className="space-y-2">
        <div className="inline-flex rounded-lg bg-surface-muted p-1">
          {(["all", "unread", "read"] as const).map((status) => (
            <Link key={status} href={notificationsHref(query, { status })} aria-current={query.status === status ? "page" : undefined}
              className={cn("inline-flex h-8 items-center rounded-md px-3 text-sm font-medium capitalize", query.status === status ? "bg-surface text-text-primary shadow-sm" : "text-text-secondary hover:text-text-primary")}>
              {status}
            </Link>
          ))}
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
          <Link href={notificationsHref(query, { category: null })} aria-current={query.category === null ? "page" : undefined}
            className={cn(chip, query.category === null ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-text-secondary hover:text-text-primary")}>All types</Link>
          {NOTIFICATION_CATEGORIES.map((category) => (
            <Link key={category} href={notificationsHref(query, { category })} aria-current={query.category === category ? "page" : undefined}
              className={cn(chip, query.category === category ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-text-secondary hover:text-text-primary")}>
              {CATEGORY_LABELS[category].label}
            </Link>
          ))}
        </div>
      </nav>

      {page.error ? (
        <StatePanel tone="danger" icon={AlertTriangle} title="Couldn’t load notifications" description={PROJECT_ERROR_MESSAGES[page.error]}
          action={<Link href={notificationsHref(query)} className={secondaryButton}>Try again</Link>} />
      ) : (
        <NotificationsList key={`${query.status}:${query.category ?? ""}`} query={query} initialPage={page.data} />
      )}
    </main>
  );
}
