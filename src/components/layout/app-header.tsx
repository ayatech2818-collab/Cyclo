import Link from "next/link";
import { LogOut, Orbit } from "lucide-react";

import { ThemeToggle } from "@/components/theme/theme-toggle";
import type { ActiveProfile } from "@/features/auth/access";
import { logout } from "@/features/auth/actions";
import { initials } from "@/features/employees/format";
import { ROLE_LABELS } from "@/features/employees/types";
import { canViewDirectory } from "@/features/employees/validation";
import type { ThemePreference } from "@/lib/theme/theme";

import { NavLink } from "./nav-link";

const iconButton =
  "inline-flex size-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-muted hover:text-text-primary";

/**
 * Navigation is a convenience only: every page and RPC behind these links
 * enforces its own role check.
 */
export function AppHeader({ profile, theme }: { profile: ActiveProfile; theme: ThemePreference }) {
  const name = profile.full_name?.trim() || profile.email || "Employee";

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-surface/90 backdrop-blur supports-[backdrop-filter]:bg-surface/75">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
        <Link href="/dashboard" className="flex items-center gap-2 rounded-md" aria-label="CYCLO dashboard">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Orbit aria-hidden="true" className="size-4.5" strokeWidth={2} />
          </span>
          <span className="hidden text-sm font-semibold tracking-widest sm:inline">CYCLO</span>
        </Link>

        <nav aria-label="Main" className="flex items-center gap-1">
          <NavLink href="/dashboard">Dashboard</NavLink>
          {canViewDirectory(profile.role) && <NavLink href="/employees">Employees</NavLink>}
        </nav>

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <ThemeToggle initial={theme} variant="compact" />
          <div className="ml-1 hidden items-center gap-2.5 border-l border-border pl-3 md:flex">
            <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {initials(profile.full_name, profile.email)}
            </span>
            <div className="text-right leading-tight">
              <p className="max-w-48 truncate text-sm font-medium">{name}</p>
              <p className="text-xs text-text-secondary">{ROLE_LABELS[profile.role]}</p>
            </div>
          </div>
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
