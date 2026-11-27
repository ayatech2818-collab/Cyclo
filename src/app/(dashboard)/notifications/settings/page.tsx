import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ArrowLeft } from "lucide-react";

import { StatePanel, secondaryButton } from "@/features/employees/components/state-panel";
import { PreferencesForm } from "@/features/notifications/components/preferences-form";
import { getNotificationPreferences } from "@/features/notifications/queries.server";
import { PROJECT_ERROR_MESSAGES } from "@/features/projects/errors";
import { loadProjectForPage } from "@/features/projects/page-errors.server";

export const metadata: Metadata = { title: "Notification settings | CYCLO" };

export default async function NotificationSettingsPage() {
  const preferences = await loadProjectForPage(() => getNotificationPreferences());
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <Link href="/notifications" className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary">
        <ArrowLeft aria-hidden="true" className="size-4" />Notifications
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Notification settings</h1>
        <p className="text-sm text-text-secondary">Choose what CYCLO notifies you about. Turning a type off stops new notifications of that type; existing ones stay.</p>
      </header>
      {preferences.error ? (
        <StatePanel tone="danger" icon={AlertTriangle} title="Couldn’t load your settings" description={PROJECT_ERROR_MESSAGES[preferences.error]}
          action={<Link href="/notifications/settings" className={secondaryButton}>Try again</Link>} />
      ) : (
        <PreferencesForm initial={preferences.data} />
      )}
    </main>
  );
}
