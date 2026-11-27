import type { ReactNode } from "react";

import { AppHeader } from "@/components/layout/app-header";
import { requireActiveProfile } from "@/features/auth/server";
import { NotificationsProvider } from "@/features/notifications/components/notifications-provider";
import { getUnreadCount } from "@/features/notifications/queries.server";
import { getMyResolvedAvatar } from "@/features/profile/avatars.server";
import { getThemePreference } from "@/lib/theme/server";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const [{ profile }, theme] = await Promise.all([requireActiveProfile(), getThemePreference()]);
  // Decorative: a failed avatar read falls back to initials inside the header.
  // The unread count is corrected by the live subscription as soon as it connects.
  const [avatar, unread] = await Promise.all([getMyResolvedAvatar(), getUnreadCount().catch(() => 0)]);
  return (
    // Keyed by user: a different session starts a fresh subscription.
    <NotificationsProvider key={profile.id} userId={profile.id} initialUnread={unread}>
      <div className="flex min-h-svh flex-col">
        <AppHeader profile={profile} theme={theme} avatar={avatar} />
        <div className="flex flex-1 flex-col">{children}</div>
      </div>
    </NotificationsProvider>
  );
}
