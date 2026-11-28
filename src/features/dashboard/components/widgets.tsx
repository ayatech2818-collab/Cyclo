import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Bell, CalendarClock, CheckCircle2, ClipboardCheck, FolderKanban, Hourglass, IterationCw, ListTodo, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge, KeyTag } from "@/components/ui/badge";
import { panel } from "@/components/ui/styles";
import type { AppRole } from "@/features/auth/access";
import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { actorLabel as notificationActor, describeNotification, notificationHref } from "@/features/notifications/logic";
import { actorLabel, describeActivity } from "@/features/projects/activity";
import { ProjectStatusBadge } from "@/features/projects/components/project-badges";
import { formatProjectDate } from "@/features/projects/format";
import { PROJECT_STATUSES, STATUS_LABELS } from "@/features/projects/types";
import { IssueKey, WorkStatusBadge, WorkTypeIcon } from "@/features/work-items/components/work-badges";
import { cn } from "@/lib/utils/cn";

import { daysLeft, sprintCompletion } from "../logic";
import type { DashboardData } from "../queries.server";
import { RelativeTime } from "./relative-time";

/* Dashboard widgets (Phase 8H Part 1). Each renders only real data it was given. */

export function Widget({ title, icon: Icon, action, className, children }: {
  title: string;
  icon: LucideIcon;
  action?: { label: string; href: string };
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn(panel, "flex min-w-0 flex-col", className)} aria-label={title}>
      <header className="flex items-center gap-2.5 px-5 pt-5 pb-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-strong">
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <h2 className="min-w-0 flex-1 text-[15px] leading-snug font-semibold">{title}</h2>
        {action && (
          <Link href={action.href} className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-text-secondary hover:bg-surface-muted hover:text-text-primary">
            {action.label}<ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        )}
      </header>
      <div className="min-w-0 flex-1 px-5 pb-5">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-text-muted">{children}</p>;
}

function Unavailable() {
  return <p className="flex items-center gap-2 rounded-lg bg-danger/5 px-4 py-3 text-sm text-danger"><AlertTriangle aria-hidden="true" className="size-4" />This information could not be loaded. Reload to try again.</p>;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const ROLE_INTRO: Record<AppRole, string> = {
  SUPER_ADMIN: "An overview of every project, the team and what needs attention.",
  PROJECT_MANAGER: "Your projects, reviews waiting for you and how your sprints are going.",
  DEVELOPER: "Your open work, current sprints and what changed in your projects.",
};

export function DashboardHeader({ data }: { data: DashboardData }) {
  const stats: { label: string; value: number; href?: string }[] = [];
  if (data.role === "SUPER_ADMIN") {
    if (data.projects) stats.push({ label: "projects", value: data.projects.total, href: "/projects" });
    if (data.employees) stats.push({ label: "active employees", value: data.employees.active, href: "/employees" });
    if (data.reviews) stats.push({ label: "reviews pending", value: data.reviews.total, href: "/reviews" });
  } else if (data.role === "PROJECT_MANAGER") {
    if (data.projects) stats.push({ label: "managed projects", value: data.projects.total, href: "/projects" });
    if (data.reviews) stats.push({ label: "reviews pending", value: data.reviews.total, href: "/reviews" });
    if (data.activeSprints) stats.push({ label: "active sprints", value: data.activeSprints.length });
  } else {
    if (data.myWork) stats.push({ label: "open items assigned", value: data.myWork.open });
    if (data.activeSprints) stats.push({ label: "active sprints", value: data.activeSprints.length });
    if (data.notifications) stats.push({ label: "unread notifications", value: data.notifications.unread, href: "/notifications" });
  }
  return (
    <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Welcome back, {data.firstName}</h1>
        <p className="mt-1 text-sm text-text-secondary">{ROLE_INTRO[data.role]}</p>
      </div>
      {stats.length > 0 && (
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          {stats.map((stat) => {
            const body = (
              <>
                <dd className="text-2xl font-semibold tracking-tight tabular-nums">{stat.value}</dd>
                <dt className="text-xs text-text-muted">{stat.label}</dt>
              </>
            );
            return stat.href ? (
              <Link key={stat.label} href={stat.href} className="flex flex-col-reverse rounded-md hover:opacity-80">{body}</Link>
            ) : (
              <div key={stat.label} className="flex flex-col-reverse">{body}</div>
            );
          })}
        </dl>
      )}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function ProjectsWidget({ data, title }: { data: DashboardData; title: string }) {
  return (
    <Widget title={title} icon={FolderKanban} action={{ label: "View all", href: "/projects" }}>
      {!data.projects ? <Unavailable /> : data.projects.items.length === 0 ? (
        <Empty>{data.role === "DEVELOPER" ? "You are not on a project team yet." : "No projects yet."}</Empty>
      ) : (
        <ul className="-mx-2 divide-y divide-border">
          {data.projects.items.slice(0, 6).map((project) => (
            <li key={project.id}>
              <Link href={`/projects/${project.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-muted">
                <KeyTag className="shrink-0 bg-primary-soft text-primary-strong">{project.projectKey}</KeyTag>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{project.name}</span>
                  <span className="block truncate text-xs text-text-muted">
                    {project.targetDate ? `Target ${formatProjectDate(project.targetDate)}` : "No target date"}
                    {data.role !== "PROJECT_MANAGER" && project.projectManagerName ? ` · PM ${project.projectManagerName}` : ""}
                  </span>
                </span>
                <ProjectStatusBadge status={project.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data.projects && data.projects.total > 6 && <p className="mt-3 text-xs text-text-muted">Showing the 6 most recently updated of {data.projects.total}.</p>}
    </Widget>
  );
}

const STATUS_BAR: Record<(typeof PROJECT_STATUSES)[number], string> = {
  planning: "bg-text-muted", active: "bg-success", on_hold: "bg-warning", completed: "bg-accent", cancelled: "bg-danger",
};

export function ProjectOverviewWidget({ data }: { data: DashboardData }) {
  const counts = data.projectStatusCounts;
  const total = counts ? PROJECT_STATUSES.reduce((sum, status) => sum + counts[status], 0) : 0;
  return (
    <Widget title="Project overview" icon={FolderKanban} action={{ label: "View all", href: "/projects" }}>
      {!counts ? <Unavailable /> : total === 0 ? <Empty>No projects yet.</Empty> : (
        <div className="space-y-4">
          <p className="text-3xl font-semibold tracking-tight tabular-nums">{total}<span className="ml-2 text-sm font-normal text-text-muted">active and closed projects</span></p>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-muted" role="img"
            aria-label={PROJECT_STATUSES.map((status) => `${STATUS_LABELS[status]} ${counts[status]}`).join(", ")}>
            {PROJECT_STATUSES.filter((status) => counts[status] > 0).map((status) => (
              <span key={status} className={STATUS_BAR[status]} style={{ width: `${(counts[status] / total) * 100}%` }} />
            ))}
          </div>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {PROJECT_STATUSES.map((status) => (
              <li key={status} className="flex items-center gap-2">
                <span aria-hidden="true" className={cn("size-2 rounded-full", STATUS_BAR[status])} />
                <span className="min-w-0 flex-1 truncate text-text-secondary">{STATUS_LABELS[status]}</span>
                <span className="font-semibold tabular-nums">{counts[status]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// Employees (Super Admin)
// ---------------------------------------------------------------------------

export function EmployeeOverviewWidget({ data }: { data: DashboardData }) {
  const employees = data.employees;
  const rows: { label: string; value: number }[] = employees
    ? [
      { label: "Super Admins", value: employees.byRole.SUPER_ADMIN },
      { label: "Project Managers", value: employees.byRole.PROJECT_MANAGER },
      { label: "Developers", value: employees.byRole.DEVELOPER },
    ]
    : [];
  return (
    <Widget title="Employees" icon={Users} action={{ label: "View all", href: "/employees" }}>
      {!employees ? <Unavailable /> : (
        <div className="space-y-4">
          <p className="text-3xl font-semibold tracking-tight tabular-nums">{employees.active}<span className="ml-2 text-sm font-normal text-text-muted">active employees</span></p>
          <ul className="space-y-2.5 text-sm">
            {rows.map((row) => (
              <li key={row.label} className="space-y-1">
                <div className="flex justify-between"><span className="text-text-secondary">{row.label}</span><span className="font-semibold tabular-nums">{row.value}</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${employees.active ? (row.value / employees.active) * 100 : 0}%` }} />
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-muted">{employees.inactive} inactive account{employees.inactive === 1 ? "" : "s"}</p>
        </div>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// Attention (Super Admin)
// ---------------------------------------------------------------------------

export function AttentionWidget({ data, className }: { data: DashboardData; className?: string }) {
  return (
    <Widget title="Projects requiring attention" icon={AlertTriangle} className={className}>
      {!data.attention ? <Unavailable /> : data.attention.length === 0 ? (
        <Empty>Nothing needs attention: no project is on hold, past its target date or waiting 3+ days on a review.</Empty>
      ) : (
        <ul className="-mx-2 divide-y divide-border">
          {data.attention.map(({ project, reasons }) => (
            <li key={project.id}>
              <Link href={`/projects/${project.id}`} className="flex flex-col gap-1.5 rounded-lg px-2 py-2.5 hover:bg-surface-muted sm:flex-row sm:items-center sm:gap-3">
                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                  <KeyTag className="shrink-0 bg-primary-soft text-primary-strong">{project.projectKey}</KeyTag>
                  <span className="truncate text-sm font-medium">{project.name}</span>
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {reasons.map((reason) => (
                    <Badge key={reason.kind} tone={reason.kind === "overdue" ? "danger" : reason.kind === "on_hold" ? "warning" : "accent"}>{reason.label}</Badge>
                  ))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// Reviews (Super Admin, Project Manager)
// ---------------------------------------------------------------------------

export function ReviewsWidget({ data, className }: { data: DashboardData; className?: string }) {
  const reviews = data.reviews;
  return (
    <Widget title="Pending reviews" icon={ClipboardCheck} action={{ label: "Open", href: "/reviews" }} className={className}>
      {!reviews ? <Unavailable /> : reviews.total === 0 ? (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <CheckCircle2 aria-hidden="true" className="size-7 text-success" />
          <p className="text-sm font-medium">All caught up</p>
          <p className="text-xs text-text-muted">No work is waiting for review.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-end justify-between gap-4">
            <p className="text-3xl font-semibold tracking-tight tabular-nums">{reviews.total}<span className="ml-2 text-sm font-normal text-text-muted">waiting</span></p>
            {reviews.oldestSubmittedAt && (
              <p className="inline-flex items-center gap-1.5 text-xs text-text-secondary"><Hourglass aria-hidden="true" className="size-3.5" />Oldest submitted <RelativeTime iso={reviews.oldestSubmittedAt} /></p>
            )}
          </div>
          <ul className="-mx-2 divide-y divide-border">
            {reviews.projects.slice(0, 4).map((project) => (
              <li key={project.id}>
                <Link href={`/reviews?project=${project.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-surface-muted">
                  <span className="font-mono text-xs text-text-muted">{project.projectKey}</span>
                  <span className="min-w-0 flex-1 truncate">{project.label}</span>
                  <Badge tone="accent" className="tabular-nums">{project.count}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// Sprints
// ---------------------------------------------------------------------------

export function SprintsWidget({ data, className }: { data: DashboardData; className?: string }) {
  return (
    <Widget title="Active sprints" icon={IterationCw} className={className}>
      {!data.activeSprints ? <Unavailable /> : data.activeSprints.length === 0 ? (
        <Empty>No active sprint in your most recently updated projects.</Empty>
      ) : (
        <ul className="space-y-3">
          {data.activeSprints.slice(0, 4).map(({ project, sprint }) => {
            const percent = sprintCompletion(sprint);
            const left = daysLeft(sprint.endDate, data.today);
            return (
              <li key={sprint.id}>
                <Link href={`/projects/${project.id}/sprints/${sprint.id}/board`} className="block rounded-lg border border-border p-3 hover:border-border-strong hover:bg-surface-muted/60">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{sprint.name}</span>
                    <span className="text-sm font-semibold tabular-nums">{percent}%</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-text-muted">{project.name}</p>
                  <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${sprint.name} progress`}>
                    <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                  </div>
                  <p className="mt-2 flex items-center justify-between text-xs text-text-secondary">
                    <span>{sprint.doneCount} of {sprint.itemCount} items done</span>
                    {left !== null && (
                      <span className={cn("inline-flex items-center gap-1", left < 0 && "text-danger")}>
                        <CalendarClock aria-hidden="true" className="size-3.5" />
                        {left > 1 ? `${left} days left` : left === 1 ? "1 day left" : left === 0 ? "Ends today" : `${-left} days over`}
                      </span>
                    )}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// My work (Developer)
// ---------------------------------------------------------------------------

export function MyWorkWidget({ data, className }: { data: DashboardData; className?: string }) {
  const work = data.myWork;
  return (
    <Widget title="My open work" icon={ListTodo} className={className}>
      {!work ? <Unavailable /> : work.items.length === 0 ? (
        <Empty>Nothing is assigned to you right now.</Empty>
      ) : (
        <ul className="-mx-2 divide-y divide-border">
          {work.items.map(({ project, item }) => (
            <li key={item.id}>
              <Link href={`/projects/${project.id}/work/${item.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-muted">
                <WorkTypeIcon type={item.type} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2"><IssueKey issueKey={item.issueKey} /><span className="truncate text-xs text-text-muted">{project.name}</span></span>
                  <span className="block truncate text-sm font-medium">{item.title}</span>
                </span>
                <span className="hidden sm:block"><WorkStatusBadge status={item.status} /></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {work && work.items.length > 0 && (
        <p className="mt-3 text-xs text-text-muted">
          {work.open > work.items.length ? `Showing ${work.items.length} of ${work.open}. ` : ""}From your {work.scannedProjects} most recently updated project{work.scannedProjects === 1 ? "" : "s"}.
        </p>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// Activity and notifications
// ---------------------------------------------------------------------------

export function ActivityWidget({ data, title = "Recent activity", wide = false, className }: { data: DashboardData; title?: string; wide?: boolean; className?: string }) {
  return (
    <Widget title={title} icon={IterationCw} className={className}>
      {!data.activity ? <Unavailable /> : data.activity.length === 0 ? (
        <Empty>No activity yet in your most recently updated projects.</Empty>
      ) : (
        <ul className={cn("space-y-3.5", wide && "lg:grid lg:grid-cols-2 lg:gap-x-10 lg:gap-y-3.5 lg:space-y-0")}>
          {data.activity.map(({ project, entry }) => (
            <li key={entry.id} className="flex gap-3">
              <EmployeeAvatar fullName={entry.actorName} email={null} avatarUrl={null} avatar={entry.actorAvatar} size="sm" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="text-text-secondary">
                  <span className="font-semibold text-text-primary">{actorLabel(entry)}</span> {describeActivity(entry)}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
                  {entry.workItem ? (
                    <Link href={`/projects/${project.id}/work/${entry.workItem.id}`} className="max-w-full truncate hover:text-text-primary">{entry.workItem.title}</Link>
                  ) : (
                    <Link href={`/projects/${project.id}/activity`} className="hover:text-text-primary">{project.name}</Link>
                  )}
                  <span aria-hidden="true">·</span>
                  <RelativeTime iso={entry.createdAt} />
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

export function NotificationsWidget({ data, className }: { data: DashboardData; className?: string }) {
  const notifications = data.notifications;
  return (
    <Widget title="Latest notifications" icon={Bell} action={{ label: "All", href: "/notifications" }} className={className}>
      {!notifications ? <Unavailable /> : notifications.recent.length === 0 ? (
        <Empty>No notifications yet.</Empty>
      ) : (
        <ul className="-mx-2 space-y-0.5">
          {notifications.recent.map((notification) => {
            const href = notificationHref(notification);
            const body = (
              <>
                <EmployeeAvatar fullName={notification.actorName} email={null} avatarUrl={null} avatar={notification.actorAvatar} size="sm" />
                <span className="min-w-0 flex-1 text-sm">
                  <span className={cn("block", notification.readAt ? "text-text-secondary" : "text-text-primary")}>
                    <span className="font-semibold">{notificationActor(notification)}</span> {describeNotification(notification)}
                  </span>
                  <RelativeTime iso={notification.createdAt} className="text-xs text-text-muted" />
                </span>
                {!notification.readAt && <span aria-label="Unread" className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />}
              </>
            );
            return (
              <li key={notification.id}>
                {href ? <Link href={href} className="flex gap-3 rounded-lg px-2 py-2 hover:bg-surface-muted">{body}</Link> : <div className="flex gap-3 px-2 py-2">{body}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </Widget>
  );
}
