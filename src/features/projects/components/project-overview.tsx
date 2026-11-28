import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock, CircleDot, Eye, IterationCw, ListTodo, OctagonAlert, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { RelativeTime } from "@/features/dashboard/components/relative-time";
import { Widget } from "@/features/dashboard/components/widgets";
import { daysLeft, sprintCompletion } from "@/features/dashboard/logic";
import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { SPRINT_STATUS_LABELS } from "@/features/sprints/types";
import { WORK_STATUS_STYLES } from "@/features/work-items/components/work-badges";
import { WORK_STATUS_LABELS, type WorkItemStatus } from "@/features/work-items/types";
import { cn } from "@/lib/utils/cn";

import { actorLabel, describeActivity } from "../activity";
import { formatProjectDate, managerLabel } from "../format";
import type { ProjectOverviewData } from "../overview.server";
import type { ProjectDetail } from "../types";

/* Project overview sections (Phase 8H Part 2). Each renders only real data it was given. */

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-text-muted">{children}</p>;
}

function Unavailable() {
  return (
    <p className="flex items-center gap-2 rounded-lg bg-danger/5 px-4 py-3 text-sm text-danger">
      <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />This information could not be loaded. Reload to try again.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Key numbers
// ---------------------------------------------------------------------------

function Stat({ icon: Icon, label, value, href, tone = "default" }: { icon: LucideIcon; label: string; value: number; href: string; tone?: "default" | "danger" }) {
  return (
    <Link href={href} className="group flex items-center gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm transition-colors hover:border-primary/40">
      <span className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl",
        tone === "danger" && value > 0 ? "bg-danger/10 text-danger" : "bg-primary-soft text-primary-strong",
      )}>
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-2xl leading-tight font-semibold tabular-nums">{value}</span>
        <span className="block truncate text-xs text-text-secondary group-hover:text-text-primary">{label}</span>
      </span>
    </Link>
  );
}

export function OverviewStats({ project, data }: { project: ProjectDetail; data: ProjectOverviewData }) {
  if (!data.work) return null;
  const count = (status: WorkItemStatus) => data.work?.byStatus[status] ?? 0;
  const base = `/projects/${project.id}`;
  return (
    <section aria-label="Open work at a glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat icon={ListTodo} label="Open items" value={data.work.total} href={`${base}/backlog`} />
      <Stat icon={CircleDot} label="In progress" value={count("IN_PROGRESS")} href={`${base}/work`} />
      <Stat icon={Eye} label="In review" value={count("IN_REVIEW")} href={`${base}/work`} />
      <Stat icon={OctagonAlert} label="Blocked" value={count("BLOCKED")} href={`${base}/work`} tone="danger" />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sprint
// ---------------------------------------------------------------------------

export function SprintCard({ project, data, today }: { project: ProjectDetail; data: ProjectOverviewData; today: string }) {
  const sprintsHref = `/projects/${project.id}/sprints`;
  const current = data.sprint;
  return (
    <Widget title={current?.state === "planned" ? "Next sprint" : "Current sprint"} icon={IterationCw} action={{ label: "All sprints", href: sprintsHref }}>
      {current === undefined ? <Unavailable /> : current === null ? (
        <Empty>No sprint is running or planned.</Empty>
      ) : (() => {
        const { sprint, state } = current;
        const percent = sprintCompletion(sprint);
        const left = daysLeft(sprint.endDate, today);
        const href = state === "active" ? `/projects/${project.id}/sprints/${sprint.id}/board` : `/projects/${project.id}/sprints/${sprint.id}`;
        return (
          <Link href={href} className="block rounded-xl border border-border p-4 transition-colors hover:border-primary/40 hover:bg-surface-muted/40">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold">{sprint.name}</p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {SPRINT_STATUS_LABELS[sprint.status]}
                  {(sprint.startDate || sprint.endDate) && <> · {formatProjectDate(sprint.startDate) ?? "?"} → {formatProjectDate(sprint.endDate) ?? "?"}</>}
                </p>
              </div>
              {state === "active" && <span className="shrink-0 text-lg font-semibold tabular-nums">{percent}%</span>}
            </div>
            {sprint.goal && <p className="mt-3 line-clamp-2 text-sm text-text-secondary">{sprint.goal}</p>}
            {state === "active" && (
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-surface-muted" role="img" aria-label={`${percent}% complete`}>
                <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
              <span>{sprint.doneCount} of {sprint.itemCount} items done{sprint.estimateTotal > 0 && ` · ${sprint.doneEstimate}/${sprint.estimateTotal} pts`}</span>
              {left !== null && (
                <span className={cn("inline-flex items-center gap-1", left < 0 && "text-danger")}>
                  <CalendarClock aria-hidden="true" className="size-3.5" />
                  {left > 1 ? `${left} days left` : left === 1 ? "1 day left" : left === 0 ? "Ends today" : `Ended ${-left} day${left === -1 ? "" : "s"} ago`}
                </span>
              )}
            </div>
            <p className="mt-3 text-xs font-medium text-primary-strong">{state === "active" ? "Open sprint board →" : "View sprint →"}</p>
          </Link>
        );
      })()}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// Open work by status
// ---------------------------------------------------------------------------

const OPEN_STATUSES: WorkItemStatus[] = ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "BLOCKED"];

export function WorkBreakdown({ project, data }: { project: ProjectDetail; data: ProjectOverviewData }) {
  const work = data.work;
  return (
    <Widget title="Open work" icon={ListTodo} action={{ label: "Backlog", href: `/projects/${project.id}/backlog` }}>
      {!work ? <Unavailable /> : work.total === 0 ? (
        <Empty>No open work items. Add stories, tasks and bugs from the backlog.</Empty>
      ) : (
        <>
          <div className="flex h-3 overflow-hidden rounded-full bg-surface-muted" role="img"
            aria-label={OPEN_STATUSES.map((status) => `${WORK_STATUS_LABELS[status]} ${work.byStatus[status] ?? 0}`).join(", ")}>
            {OPEN_STATUSES.map((status) => {
              const value = work.byStatus[status] ?? 0;
              return value > 0 ? <div key={status} className={WORK_STATUS_STYLES[status].dot} style={{ width: `${(value / work.total) * 100}%` }} /> : null;
            })}
          </div>
          <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm sm:grid-cols-3 2xl:grid-cols-2">
            {OPEN_STATUSES.map((status) => (
              <li key={status} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 text-text-secondary">
                  <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", WORK_STATUS_STYLES[status].dot)} />
                  <span className="truncate">{WORK_STATUS_LABELS[status]}</span>
                </span>
                <span className="font-semibold tabular-nums">{work.byStatus[status] ?? 0}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-4 text-center">
            <div>
              <dt className="text-xs text-text-muted">Unassigned</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">{work.unassigned}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Not estimated</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">{work.unestimated}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Estimated</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">{work.estimate ?? 0} pts</dd>
            </div>
          </dl>
        </>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

const TEAM_PREVIEW = 6;

export function TeamCard({ project, data, children }: { project: ProjectDetail; data: ProjectOverviewData; children?: ReactNode }) {
  const members = data.members;
  return (
    <Widget title="Team" icon={Users} action={{ label: "View team", href: `/projects/${project.id}/team` }}>
      <div className="flex items-center gap-3 rounded-xl bg-surface-muted/60 p-3">
        <EmployeeAvatar fullName={project.projectManagerName} email={null} avatarUrl={null} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{managerLabel(project.projectManagerName)}</p>
          <p className="truncate text-xs text-text-secondary">{project.projectManagerEmail ?? "Project Manager"}</p>
        </div>
        <span className="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary-strong">PM</span>
      </div>
      {!project.projectManagerIsActive && (
        <p className="mt-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">This Project Manager is no longer active.</p>
      )}

      <div className="mt-4">
        {!members ? <Unavailable /> : members.length === 0 ? (
          <Empty>No developers on this project yet.</Empty>
        ) : (
          <>
            <p className="mb-2 text-xs font-medium text-text-muted">{members.length} developer{members.length === 1 ? "" : "s"}</p>
            <ul className="space-y-2">
              {members.slice(0, TEAM_PREVIEW).map((member) => (
                <li key={member.membershipId} className="flex items-center gap-2.5">
                  <EmployeeAvatar fullName={member.fullName} email={member.email} avatarUrl={null} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-sm", member.isActive ? "text-text-primary" : "text-text-muted line-through")}>{member.fullName?.trim() || member.email || "Unnamed"}</span>
                  </span>
                  {!member.isActive && <span className="shrink-0 text-[11px] text-text-muted">Inactive</span>}
                </li>
              ))}
            </ul>
            {members.length > TEAM_PREVIEW && (
              <Link href={`/projects/${project.id}/team`} className="mt-3 inline-block text-xs font-medium text-primary-strong hover:underline">
                +{members.length - TEAM_PREVIEW} more
              </Link>
            )}
          </>
        )}
      </div>
      {children}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export function RecentActivity({ project, data }: { project: ProjectDetail; data: ProjectOverviewData }) {
  return (
    <Widget title="Recent activity" icon={IterationCw} action={{ label: "View all", href: `/projects/${project.id}/activity` }}>
      {!data.activity ? <Unavailable /> : data.activity.length === 0 ? (
        <Empty>No activity yet.</Empty>
      ) : (
        <ol className="relative space-y-4 before:absolute before:top-2 before:bottom-2 before:left-4 before:w-px before:bg-border">
          {data.activity.map((entry) => (
            <li key={entry.id} className="relative flex gap-3">
              <span className="relative rounded-full ring-4 ring-surface">
                <EmployeeAvatar fullName={entry.actorName} email={null} avatarUrl={null} avatar={entry.actorAvatar} size="sm" />
              </span>
              <div className="min-w-0 flex-1 pt-0.5 text-sm">
                <p className="text-text-secondary">
                  <span className="font-semibold text-text-primary">{actorLabel(entry)}</span> {describeActivity(entry)}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
                  {entry.workItem && (
                    <>
                      <Link href={`/projects/${project.id}/work/${entry.workItem.id}`} className="max-w-full truncate hover:text-text-primary">
                        {entry.workItem.issueKey} · {entry.workItem.title}
                      </Link>
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  <RelativeTime iso={entry.createdAt} />
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-sm text-text-secondary">{term}</dt>
      <dd className="min-w-0 text-right text-sm font-medium">{children}</dd>
    </div>
  );
}

export function DetailsCard({ project }: { project: ProjectDetail }) {
  const notSet = <span className="font-normal text-text-muted">Not set</span>;
  return (
    <Widget title="Details" icon={CalendarClock}>
      <dl className="-my-1 divide-y divide-border">
        <DetailRow term="Start date">{formatProjectDate(project.startDate) ?? notSet}</DetailRow>
        <DetailRow term="Target date">{formatProjectDate(project.targetDate) ?? notSet}</DetailRow>
        <DetailRow term="Created">
          {formatProjectDate(project.createdAt)}
          {project.createdByName && <span className="block text-xs font-normal text-text-secondary">by {project.createdByName}</span>}
        </DetailRow>
        <DetailRow term="Last updated">{formatProjectDate(project.updatedAt)}</DetailRow>
        <DetailRow term="Project key"><span className="font-mono">{project.projectKey}</span></DetailRow>
      </dl>
    </Widget>
  );
}
