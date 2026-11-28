import type { ReactNode } from "react";
import { cookies } from "next/headers";

import { accountSummary, AppHeader } from "@/components/layout/app-header";
import { CurrentProjectProvider } from "@/components/layout/current-project";
import { LAST_PROJECT_COOKIE, parseLastProject } from "@/components/layout/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { requireActiveProfile } from "@/features/auth/server";
import { NotificationsProvider } from "@/features/notifications/components/notifications-provider";
import { getUnreadCount } from "@/features/notifications/queries.server";
import { getMyResolvedAvatar } from "@/features/profile/avatars.server";
import { getProjectSummaryAction } from "@/features/projects/switcher-actions";
import { getThemePreference } from "@/lib/theme/server";

/**
 * Application shell (Phase 8H Part 1): permanent sidebar (icon rail from md,
 * full from lg, drawer on phones), compact header, and the page.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const [{ profile }, theme, cookieStore] = await Promise.all([requireActiveProfile(), getThemePreference(), cookies()]);
  const lastProjectId = parseLastProject(cookieStore.get(LAST_PROJECT_COOKIE)?.value, profile.id);
  // Decorative or recoverable reads: each falls back without breaking the page.
  // The remembered project is checked against current access (the existing project RPC).
  const [avatar, unread, lastProject] = await Promise.all([
    getMyResolvedAvatar(),
    getUnreadCount().catch(() => 0),
    lastProjectId ? getProjectSummaryAction(lastProjectId) : Promise.resolve(null),
  ]);
  const account = accountSummary(profile, avatar);

  return (
    // Keyed by user: a different session starts fresh subscriptions and project state.
    <NotificationsProvider key={profile.id} userId={profile.id} initialUnread={unread}>
      <CurrentProjectProvider key={profile.id} userId={profile.id} initial={lastProject}>
        <a href="#main-content"
          className="sr-only z-[60] rounded-full bg-action px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
          Skip to content
        </a>
        <div className="min-h-svh md:pl-[5.25rem] lg:pl-[17.25rem]">
          <aside aria-label="Sidebar" className="fixed inset-y-0 left-0 z-40 hidden w-[5.25rem] p-3 md:block lg:w-[17.25rem]">
            <div className="h-full rounded-xl border border-border bg-surface p-3 shadow-sm">
              <Sidebar role={profile.role} account={account} mode="docked" />
            </div>
          </aside>
          <div className="flex min-h-svh min-w-0 flex-col">
            <AppHeader profile={profile} theme={theme} avatar={avatar} />
            <div id="main-content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">{children}</div>
          </div>
        </div>
      </CurrentProjectProvider>
    </NotificationsProvider>
  );
}
