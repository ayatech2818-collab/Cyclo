"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity, Bell, ClipboardCheck, FolderKanban, IterationCw, Layers, LayoutDashboard, LayoutGrid, ListTodo, Orbit, Settings, Users, UsersRound,
  type LucideIcon,
} from "lucide-react";

import { CountBadge } from "@/components/ui/badge";
import type { AppRole } from "@/features/auth/access";
import { useNotifications } from "@/features/notifications/components/notifications-provider";
import { cn } from "@/lib/utils/cn";

import { AccountMenu, type AccountSummary } from "./account-menu";
import { useCurrentProject } from "./current-project";
import { activeNavId, managementNav, projectNav, workspaceNav, type NavIcon, type NavItem } from "./navigation";
import { ProjectSwitcher } from "./project-switcher";

const ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard, projects: FolderKanban, reviews: ClipboardCheck, notifications: Bell, employees: Users, settings: Settings,
  overview: LayoutGrid, work: ListTodo, backlog: Layers, sprints: IterationCw, team: UsersRound, activity: Activity,
};

/**
 * The application sidebar. "docked": the permanent panel, full width from lg
 * and an icon rail between md and lg (labels stay available to screen readers
 * and as tooltips). "drawer": always full, inside the phone drawer.
 */
export function Sidebar({ role, account, mode, onNavigate }: { role: AppRole; account: AccountSummary; mode: "docked" | "drawer"; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = activeNavId(pathname);
  const { project } = useCurrentProject();
  const { unread } = useNotifications();
  const rail = mode === "docked";
  /** Classes applied only while the docked sidebar is a rail (md to lg). */
  const railOnly = (classes: string) => (rail ? classes : "");

  const renderItem = (item: NavItem, nested = false) => {
    const Icon = ICONS[item.icon];
    const isActive = item.id === active;
    const count = item.id === "notifications" ? unread : 0;
    return (
      <li key={item.id}>
        <Link href={item.href} onClick={onNavigate} aria-current={isActive ? "page" : undefined} title={rail ? item.label : undefined}
          className={cn(
            "group relative flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors duration-100",
            nested && "h-8",
            isActive ? "bg-primary-soft text-primary-strong" : "text-text-secondary hover:bg-surface-muted hover:text-text-primary",
            railOnly("max-lg:size-11 max-lg:justify-center max-lg:px-0"),
          )}>
          {isActive && <span aria-hidden="true" className={cn("absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-primary", railOnly("max-lg:hidden"))} />}
          <Icon aria-hidden="true" className={cn("size-4 shrink-0", isActive ? "text-primary" : "text-text-muted group-hover:text-text-secondary")} />
          <span className={cn("min-w-0 flex-1 truncate", railOnly("max-lg:sr-only"))}>{item.label}</span>
          {count > 0 && (
            <>
              <CountBadge count={count} label={`${count} unread`} className={railOnly("max-lg:hidden")} />
              {rail && <span aria-hidden="true" className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary ring-2 ring-surface lg:hidden" />}
            </>
          )}
        </Link>
      </li>
    );
  };

  const group = (label: string) => (
    <>
      <p className={cn("mt-5 mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-text-muted uppercase", railOnly("max-lg:hidden"))}>{label}</p>
      {rail && <div aria-hidden="true" className="mx-auto mt-4 mb-3 h-px w-8 bg-border lg:hidden" />}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Link href="/dashboard" onClick={onNavigate} aria-label="CYCLO dashboard"
        className={cn("flex items-center gap-2.5 rounded-md px-2 py-1", railOnly("max-lg:justify-center max-lg:px-0"))}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-action text-primary-foreground shadow-sm">
          <Orbit aria-hidden="true" className="size-4.5" strokeWidth={2.25} />
        </span>
        <span className={cn("text-[15px] font-bold tracking-[0.14em]", railOnly("max-lg:sr-only"))}>CYCLO</span>
      </Link>

      <nav aria-label="Main" className="-mx-1 mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-2 [scrollbar-width:thin]">
        {group("Workspace")}
        <ul className="space-y-0.5">{workspaceNav(role).map((item) => renderItem(item))}</ul>

        {group("Current project")}
        <div className={cn("mb-1.5", railOnly("max-lg:flex max-lg:justify-center"))}>
          {rail ? (
            <>
              <div className="hidden lg:block"><ProjectSwitcher onNavigate={onNavigate} /></div>
              <div className="lg:hidden"><ProjectSwitcher compact onNavigate={onNavigate} /></div>
            </>
          ) : (
            <ProjectSwitcher onNavigate={onNavigate} />
          )}
        </div>
        {project ? (
          <ul aria-label={`${project.name} sections`} className={cn("ml-3 space-y-0.5 border-l border-border pl-2", railOnly("max-lg:ml-0 max-lg:border-l-0 max-lg:pl-0"))}>
            {projectNav(project.id).map((item) => renderItem(item, true))}
          </ul>
        ) : (
          <p className={cn("px-3 text-xs text-text-muted", railOnly("max-lg:sr-only"))}>Choose a project to see its overview, work, backlog, sprints, team and activity.</p>
        )}

        {group("Management")}
        <ul className="space-y-0.5">{managementNav(role).map((item) => renderItem(item))}</ul>
      </nav>

      <div className={cn("border-t border-border pt-2", railOnly("max-lg:flex max-lg:justify-center"))}>
        {rail ? (
          <>
            <div className="hidden lg:block"><AccountMenu account={account} variant="card" /></div>
            <div className="lg:hidden"><AccountMenu account={account} variant="card" compact /></div>
          </>
        ) : (
          <AccountMenu account={account} variant="card" />
        )}
      </div>
    </div>
  );
}
