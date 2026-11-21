import Link from "next/link";
import { LogOut } from "lucide-react";

import type { ActiveProfile } from "@/features/auth/access";
import { logout } from "@/features/auth/actions";
import { ROLE_LABELS } from "@/features/employees/types";
import { canViewDirectory } from "@/features/employees/validation";

import { NavLink } from "./nav-link";

/**
 * Navigation is a convenience only: every page and RPC behind these links
 * enforces its own role check.
 */
export function AppHeader({ profile }: { profile: ActiveProfile }) {
  const name = profile.full_name?.trim() || profile.email || "Employee";

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/dashboard" className="text-sm font-semibold tracking-widest text-primary">CYCLO</Link>

        <nav aria-label="Main" className="flex items-center gap-1">
          <NavLink href="/dashboard">Dashboard</NavLink>
          {canViewDirectory(profile.role) && <NavLink href="/employees">Employees</NavLink>}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <p className="max-w-48 truncate text-sm font-medium">{name}</p>
            <p className="text-xs text-text-secondary">{ROLE_LABELS[profile.role]}</p>
          </div>
          <form action={logout}>
            <button
              type="submit"
              className="inline-flex size-9 items-center justify-center rounded-md text-text-secondary hover:bg-background hover:text-text-primary"
              aria-label="Log out"
              title="Log out"
            >
              <LogOut aria-hidden="true" className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
