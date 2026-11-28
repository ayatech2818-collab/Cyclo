import Link from "next/link";

import { RelativeTime } from "@/features/dashboard/components/relative-time";
import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { cn } from "@/lib/utils/cn";

import { formatProjectDate, managerLabel } from "../format";
import { projectSchedule, SCHEDULE_TEXT } from "../schedule";
import type { ProjectListItem } from "../types";
import { ArchivedBadge, ProjectPriorityBadge, ProjectStatusBadge } from "./project-badges";
import { ProjectKeyTile, ScheduleBar } from "./project-visuals";

/* Projects listing (Phase 8H Part 2): cards for the grid, rows for the list. Data is unchanged. */

function Manager({ name }: { name: string | null }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <EmployeeAvatar fullName={name} email={null} avatarUrl={null} size="sm" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-text-primary">{managerLabel(name)}</span>
        <span className="block text-xs text-text-muted">Project Manager</span>
      </span>
    </span>
  );
}

export function ProjectGrid({ projects, today }: { projects: ProjectListItem[]; today: string }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => (
        <li key={project.id}>
          <article className="group relative flex h-full flex-col rounded-xl border border-border bg-surface p-5 shadow-sm transition duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0">
            <div className="flex items-start gap-3">
              <ProjectKeyTile projectKey={project.projectKey} />
              <div className="min-w-0 flex-1">
                <h2 className="line-clamp-2 text-base leading-snug font-semibold tracking-tight">
                  {/* The whole card is the link target; other content stays plain text. */}
                  <Link href={`/projects/${project.id}`} className="after:absolute after:inset-0 after:rounded-xl group-hover:text-primary-strong focus-visible:outline-none">
                    {project.name}
                  </Link>
                </h2>
                <p className="mt-0.5 font-mono text-xs text-text-muted">{project.projectKey}</p>
              </div>
            </div>

            <p className="mt-3 line-clamp-2 min-h-10 text-sm leading-relaxed text-text-secondary">
              {project.description || <span className="text-text-muted">No description</span>}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-1.5">
              <ProjectStatusBadge status={project.status} />
              <ProjectPriorityBadge priority={project.priority} />
              {project.archivedAt && <ArchivedBadge />}
            </div>

            <ScheduleBar schedule={projectSchedule(project, today)} startDate={project.startDate} targetDate={project.targetDate} className="mt-4" />

            <div aria-hidden="true" className="min-h-4 flex-1" />
            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <Manager name={project.projectManagerName} />
              <span className="shrink-0 text-xs text-text-muted">Updated <RelativeTime iso={project.updatedAt} /></span>
            </div>
          </article>
        </li>
      ))}
    </ul>
  );
}

export function ProjectTable({ projects, today }: { projects: ProjectListItem[]; today: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      {/* Phones: stacked rows. */}
      <ul className="divide-y divide-border md:hidden">
        {projects.map((project) => {
          const schedule = projectSchedule(project, today);
          return (
            <li key={project.id} className="relative flex gap-3 p-4 hover:bg-surface-muted/60">
              <ProjectKeyTile projectKey={project.projectKey} size="sm" />
              <div className="min-w-0 flex-1">
                <Link href={`/projects/${project.id}`} className="block truncate font-medium after:absolute after:inset-0">{project.name}</Link>
                <p className="mt-0.5 truncate text-xs text-text-secondary">{managerLabel(project.projectManagerName)}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <ProjectStatusBadge status={project.status} />
                  <ProjectPriorityBadge priority={project.priority} />
                  {project.archivedAt && <ArchivedBadge />}
                </div>
                {schedule.label && <p className={cn("mt-2 text-xs font-medium", SCHEDULE_TEXT[schedule.tone])}>{schedule.label}</p>}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Tablet and up: a table. */}
      <table className="hidden w-full text-left text-sm md:table">
        <thead className="border-b border-border bg-surface-muted/60 text-xs font-medium text-text-secondary">
          <tr>
            <th scope="col" className="px-4 py-3">Project</th>
            <th scope="col" className="px-4 py-3">Status</th>
            <th scope="col" className="hidden px-4 py-3 lg:table-cell">Priority</th>
            <th scope="col" className="hidden px-4 py-3 lg:table-cell">Project Manager</th>
            <th scope="col" className="px-4 py-3">Target date</th>
            <th scope="col" className="hidden px-4 py-3 xl:table-cell">Updated</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => {
            const schedule = projectSchedule(project, today);
            return (
              <tr key={project.id} className="border-b border-border last:border-0 hover:bg-surface-muted/50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <ProjectKeyTile projectKey={project.projectKey} size="sm" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Link href={`/projects/${project.id}`} className="truncate font-medium hover:text-primary-strong">{project.name}</Link>
                        {project.archivedAt && <ArchivedBadge />}
                      </div>
                      <p className="max-w-[22rem] truncate text-xs text-text-muted">{project.description || project.projectKey}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3"><ProjectStatusBadge status={project.status} /></td>
                <td className="hidden px-4 py-3 lg:table-cell"><ProjectPriorityBadge priority={project.priority} /></td>
                <td className="hidden max-w-52 px-4 py-3 lg:table-cell">
                  <span className="flex items-center gap-2">
                    <EmployeeAvatar fullName={project.projectManagerName} email={null} avatarUrl={null} size="sm" />
                    <span className="truncate text-text-secondary">{managerLabel(project.projectManagerName)}</span>
                  </span>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <span className="block text-text-secondary">{formatProjectDate(project.targetDate) ?? "—"}</span>
                  {schedule.label && <span className={cn("block text-xs font-medium", SCHEDULE_TEXT[schedule.tone])}>{schedule.label}</span>}
                </td>
                <td className="hidden px-4 py-3 whitespace-nowrap text-text-secondary xl:table-cell"><RelativeTime iso={project.updatedAt} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
