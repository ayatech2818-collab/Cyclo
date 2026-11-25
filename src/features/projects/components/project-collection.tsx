import Link from "next/link";
import { CalendarDays, UserRound } from "lucide-react";

import { formatDateRange, formatProjectDate, managerLabel } from "../format";
import type { ProjectListItem } from "../types";
import { ArchivedBadge, ProjectKeyBadge, ProjectPriorityBadge, ProjectStatusBadge } from "./project-badges";

export function ProjectGrid({ projects }: { projects: ProjectListItem[] }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => {
        const range = formatDateRange(project.startDate, project.targetDate);
        return (
          <li key={project.id}>
            <Link
              href={`/projects/${project.id}`}
              className="group flex h-full flex-col rounded-xl border border-border bg-surface p-5 shadow-sm transition-colors hover:border-primary/40"
            >
              <div className="flex items-start justify-between gap-3">
                <ProjectKeyBadge projectKey={project.projectKey} />
                <ProjectPriorityBadge priority={project.priority} />
              </div>
              <h2 className="mt-3 line-clamp-2 text-base font-semibold tracking-tight group-hover:text-primary">{project.name}</h2>
              <p className="mt-1 line-clamp-2 min-h-10 text-sm text-text-secondary">
                {project.description || <span className="text-text-muted">No description</span>}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <ProjectStatusBadge status={project.status} />
                {project.archivedAt && <ArchivedBadge />}
              </div>
              <dl className="mt-4 space-y-1.5 border-t border-border pt-4 text-xs text-text-secondary">
                <div className="flex items-center gap-2">
                  <dt><UserRound aria-hidden="true" className="size-3.5" /><span className="sr-only">Project Manager</span></dt>
                  <dd className="truncate">{managerLabel(project.projectManagerName)}</dd>
                </div>
                <div className="flex items-center gap-2">
                  <dt><CalendarDays aria-hidden="true" className="size-3.5" /><span className="sr-only">Schedule</span></dt>
                  <dd>{range ?? "No dates set"}</dd>
                </div>
              </dl>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function ProjectTable({ projects }: { projects: ProjectListItem[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <thead className="border-b border-border bg-surface-muted/60 text-xs font-medium text-text-secondary">
          <tr>
            <th scope="col" className="px-4 py-3">Project</th>
            <th scope="col" className="px-4 py-3">Status</th>
            <th scope="col" className="px-4 py-3">Priority</th>
            <th scope="col" className="px-4 py-3">Project Manager</th>
            <th scope="col" className="px-4 py-3">Target date</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id} className="border-b border-border last:border-0 hover:bg-surface-muted/50">
              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <ProjectKeyBadge projectKey={project.projectKey} className="shrink-0" />
                  <Link href={`/projects/${project.id}`} className="font-medium hover:text-primary">{project.name}</Link>
                  {project.archivedAt && <ArchivedBadge />}
                </div>
              </td>
              <td className="px-4 py-3"><ProjectStatusBadge status={project.status} /></td>
              <td className="px-4 py-3"><ProjectPriorityBadge priority={project.priority} /></td>
              <td className="max-w-48 truncate px-4 py-3 text-text-secondary">{managerLabel(project.projectManagerName)}</td>
              <td className="px-4 py-3 whitespace-nowrap text-text-secondary">{formatProjectDate(project.targetDate) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
