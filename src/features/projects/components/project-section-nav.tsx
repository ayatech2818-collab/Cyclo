import Link from "next/link";

import { cn } from "@/lib/utils/cn";

export type ProjectSection = "overview" | "team" | "work" | "backlog" | "sprints" | "activity";

/** Project sections (Phases 8A–8F1). Every entry is a real page. */
const SECTIONS: readonly { id: ProjectSection; label: string; path: string }[] = [
  { id: "overview", label: "Overview", path: "" },
  { id: "team", label: "Team", path: "/team" },
  { id: "work", label: "Work", path: "/work" },
  { id: "backlog", label: "Backlog", path: "/backlog" },
  { id: "sprints", label: "Sprints", path: "/sprints" },
  { id: "activity", label: "Activity", path: "/activity" },
];

export function ProjectSectionNav({ projectId, current }: { projectId: string; current: ProjectSection }) {
  return (
    <nav aria-label="Project sections" className="-mb-px overflow-x-auto border-b border-border">
      <ul className="flex min-w-max gap-1">
        {SECTIONS.map((section) => {
          const active = section.id === current;
          return (
            <li key={section.id}>
              <Link
                href={`/projects/${projectId}${section.path}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium",
                  active ? "border-accent text-text-primary" : "border-transparent text-text-secondary hover:text-text-primary",
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
