import Link from "next/link";
import { LogOut, Orbit } from "lucide-react";

import { ThemeToggle } from "@/components/theme/theme-toggle";
import type { ActiveProfile } from "@/features/auth/access";
import { logout } from "@/features/auth/actions";
import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import type { ResolvedAvatar } from "@/features/profile/avatar";
import { ROLE_LABELS } from "@/features/employees/types";
import { canViewDirectory } from "@/features/employees/validation";
import { NotificationBell } from "@/features/notifications/components/notification-bell";
import { canUseReviewInbox } from "@/features/reviews/logic";
import type { ThemePreference } from "@/lib/theme/theme";

import { NavLink } from "./nav-link";

const iconButton =
  "inline-flex size-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-muted hover:text-text-primary";

/**
 * Navigation is a convenience only: every page and RPC behind these links
 * enforces its own role check.
 */
export function AppHeader({ profile, theme, avatar = null }: { profile: ActiveProfile; theme: ThemePreference; avatar?: ResolvedAvatar | null }) {
  const name = profile.full_name?.trim() || profile.email || "Employee";

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-surface/90 backdrop-blur supports-[backdrop-filter]:bg-surface/75">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
        <Link href="/dashboard" className="flex shrink-0 items-center gap-2 rounded-md" aria-label="CYCLO dashboard">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Orbit aria-hidden="true" className="size-4.5" strokeWidth={2} />
          </span>
          <span className="hidden text-sm font-semibold tracking-widest sm:inline">CYCLO</span>
        </Link>

        <nav aria-label="Main" className="-mx-1 flex min-w-0 items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none]">
          <NavLink href="/dashboard">Dashboard</NavLink>
          <NavLink href="/projects">Projects</NavLink>
          {canUseReviewInbox(profile.role) && <NavLink href="/reviews">Reviews</NavLink>}
          {canViewDirectory(profile.role) && <NavLink href="/employees">Employees</NavLink>}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <NotificationBell />
          <ThemeToggle initial={theme} variant="compact" />
          <Link
            href="/profile"
            aria-label="Your profile"
            className="ml-1 flex items-center gap-2.5 rounded-md border-border pl-1 hover:bg-surface-muted md:border-l md:pl-3"
          >
            <EmployeeAvatar fullName={profile.full_name} email={profile.email} avatarUrl={null} avatar={avatar} size="sm" />
            <div className="hidden text-right leading-tight md:block">
              <p className="max-w-48 truncate text-sm font-medium">{name}</p>
              <p className="text-xs text-text-secondary">{ROLE_LABELS[profile.role]}</p>
            </div>
          </Link>
          <form action={logout}>
            <button type="submit" className={iconButton} aria-label="Log out" title="Log out">
              <LogOut aria-hidden="true" className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
