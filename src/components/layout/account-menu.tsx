"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BellRing, ChevronsUpDown, LogOut, UserRound } from "lucide-react";

import type { AppRole } from "@/features/auth/access";
import { logout } from "@/features/auth/actions";
import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import type { ResolvedAvatar } from "@/features/profile/avatar";
import { cn } from "@/lib/utils/cn";

const ROLE_LABELS: Record<AppRole, string> = { SUPER_ADMIN: "Super Admin", PROJECT_MANAGER: "Project Manager", DEVELOPER: "Developer" };

export type AccountSummary = { name: string; email: string | null; role: AppRole; avatar: ResolvedAvatar | null };

/**
 * Account menu (existing pages and the existing logout action only). Shown as
 * an avatar button in the header and as the account card at the bottom of the
 * sidebar.
 */
export function AccountMenu({ account, variant, compact = false }: { account: AccountSummary; variant: "avatar" | "card"; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const [path, setPath] = useState(pathname);
  if (path !== pathname) {
    setPath(pathname);
    if (open) setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const avatar = <EmployeeAvatar fullName={account.name} email={account.email} avatarUrl={null} avatar={account.avatar} size="sm" />;
  const item = "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary focus-visible:bg-surface-muted";

  return (
    <div ref={wrapper} className="relative">
      <button ref={trigger} type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="menu"
        aria-controls={open ? `${id}-menu` : undefined} aria-label={`Account: ${account.name}`} title={compact ? account.name : undefined}
        className={cn(
          "flex items-center rounded-full transition-colors duration-100",
          variant === "avatar" && "p-0.5 hover:ring-2 hover:ring-border",
          variant === "card" && (compact ? "justify-center rounded-lg p-1.5 hover:bg-surface-muted" : "w-full gap-2.5 rounded-lg p-2 text-left hover:bg-surface-muted"),
        )}>
        {avatar}
        {variant === "card" && !compact && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{account.name}</span>
              <span className="block truncate text-xs text-text-muted">{ROLE_LABELS[account.role]}</span>
            </span>
            <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
          </>
        )}
      </button>

      {open && (
        <div id={`${id}-menu`} role="menu" aria-label="Account"
          className={cn(
            "absolute z-50 w-64 overflow-hidden rounded-xl border border-border bg-surface p-1.5 shadow-lg",
            variant === "avatar" ? "top-full right-0 mt-2" : compact ? "bottom-0 left-full ml-3" : "bottom-full left-0 mb-2 w-full min-w-60",
          )}>
          <div className="flex items-center gap-2.5 px-2.5 pt-1.5 pb-2.5">
            {avatar}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{account.name}</p>
              <p className="truncate text-xs text-text-muted">{account.email ?? ROLE_LABELS[account.role]}</p>
            </div>
          </div>
          <div className="mb-1 border-t border-border" />
          <Link role="menuitem" href="/profile" className={item}><UserRound aria-hidden="true" className="size-4" />Profile and settings</Link>
          <Link role="menuitem" href="/notifications/settings" className={item}><BellRing aria-hidden="true" className="size-4" />Notification settings</Link>
          <div className="my-1 border-t border-border" />
          <form action={logout}>
            <button role="menuitem" type="submit" className={cn(item, "text-danger hover:text-danger")}><LogOut aria-hidden="true" className="size-4" />Log out</button>
          </form>
        </div>
      )}
    </div>
  );
}
