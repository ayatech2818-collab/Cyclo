import { ThemeToggle } from "@/components/theme/theme-toggle";
import type { ActiveProfile } from "@/features/auth/access";
import { NotificationBell } from "@/features/notifications/components/notification-bell";
import type { ResolvedAvatar } from "@/features/profile/avatar";
import type { ThemePreference } from "@/lib/theme/theme";

import { AccountMenu, type AccountSummary } from "./account-menu";
import { MobileNav } from "./mobile-nav";
import { PageTitle } from "./page-title";

export function accountSummary(profile: ActiveProfile, avatar: ResolvedAvatar | null): AccountSummary {
  return { name: profile.full_name?.trim() || profile.email || "Employee", email: profile.email, role: profile.role, avatar };
}

/**
 * Compact application header: phone menu button, breadcrumb, notifications,
 * theme and account. Navigation itself lives in the sidebar. Every link here
 * is a convenience: pages and RPCs enforce their own permissions.
 */
export function AppHeader({ profile, theme, avatar = null }: { profile: ActiveProfile; theme: ThemePreference; avatar?: ResolvedAvatar | null }) {
  const account = accountSummary(profile, avatar);
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="flex h-14 items-center gap-2 px-4 sm:px-6">
        <MobileNav role={profile.role} account={account} />
        <PageTitle />
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
          <NotificationBell />
          <ThemeToggle initial={theme} variant="compact" />
          <AccountMenu account={account} variant="avatar" />
        </div>
      </div>
    </header>
  );
}
