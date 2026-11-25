import Link from "next/link";

import { cn } from "@/lib/utils/cn";

/**
 * Project sections. Only Overview exists in Phase 8A; the others are shown as
 * unavailable (not links) so no empty or fake pages are reachable.
 */
const SECTIONS = [
  { id: "overview", label: "Overview", available: true },
  { id: "team", label: "Team", available: false },
  { id: "work", label: "Work", available: false },
  { id: "sprints", label: "Sprints", available: false },
  { id: "activity", label: "Activity", available: false },
] as const;

export function ProjectSectionNav({ projectId, current }: { projectId: string; current: "overview" }) {
  return (
    <nav aria-label="Project sections" className="-mb-px overflow-x-auto border-b border-border">
      <ul className="flex min-w-max gap-1">
        {SECTIONS.map((section) => {
          const active = section.id === current;
          return (
            <li key={section.id}>
              {section.available ? (
                <Link
                  href={`/projects/${projectId}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium",
                    active ? "border-accent text-text-primary" : "border-transparent text-text-secondary hover:text-text-primary",
                  )}
                >
                  {section.label}
                </Link>
              ) : (
                <span
                  aria-disabled="true"
                  title="Available in a later release"
                  className="inline-flex h-10 cursor-not-allowed items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium text-text-muted"
                >
                  {section.label}
                  <span className="rounded bg-surface-muted px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase">Soon</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
