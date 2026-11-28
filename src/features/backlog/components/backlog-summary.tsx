import Link from "next/link";
import type { ReactNode } from "react";
import { Inbox, ListChecks, PlayCircle, Ruler, UserX } from "lucide-react";

import { WorkTypeIcon } from "@/features/work-items/components/work-badges";
import { cn } from "@/lib/utils/cn";

import { backlogHref, formatPoints } from "../logic";
import type { BacklogQuery, BacklogSummary } from "../types";

type Tone = "neutral" | "accent" | "warning";

const TONES: Record<Tone, string> = {
  neutral: "border-border bg-surface text-text-secondary",
  accent: "border-accent/25 bg-accent/10 text-accent",
  warning: "border-warning/30 bg-warning/10 text-warning",
};

/** One compact health figure; a link when it maps to an existing filter. */
function Pill({ icon: Icon, label, value, href, tone = "neutral", active = false, title }: {
  icon: typeof Inbox;
  label: ReactNode;
  value: number;
  href?: string;
  tone?: Tone;
  active?: boolean;
  title?: string;
}) {
  const className = cn(
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors duration-100",
    active ? "border-primary/40 bg-primary-soft text-primary-strong" : TONES[tone],
    href && !active && "hover:border-border-strong hover:text-text-primary",
  );
  const body = (
    <>
      <Icon aria-hidden="true" className="size-3.5" />
      <span className="font-semibold tabular-nums">{value}</span>
      {label}
    </>
  );
  return href
    ? <Link href={href} aria-current={active ? "true" : undefined} title={title} className={className}>{body}</Link>
    : <span title={title} className={className}>{body}</span>;
}

/**
 * Backlog health in one scrollable row (Phase 8H Part 4), then the epics.
 * Counts cover open (not done or cancelled) stories, tasks and bugs.
 */
export function BacklogSummaryPanel({ projectId, query, summary }: { projectId: string; query: BacklogQuery; summary: BacklogSummary }) {
  const inFlight = (summary.byStatus.IN_PROGRESS ?? 0) + (summary.byStatus.IN_REVIEW ?? 0) + (summary.byStatus.BLOCKED ?? 0);
  const blocked = summary.byStatus.BLOCKED ?? 0;
  const filterHref = (overrides: Partial<BacklogQuery>) => backlogHref(projectId, query, { ...overrides, page: 1 });
  const unassignedActive = query.assignee.kind === "unassigned";

  return (
    <section aria-label="Backlog summary" className="space-y-3">
      <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex min-w-max gap-2">
          <Pill icon={Inbox} label="waiting for planning" value={summary.byStatus.BACKLOG ?? 0}
            active={query.status === "BACKLOG"} href={filterHref({ status: query.status === "BACKLOG" ? null : "BACKLOG" })} />
          <Pill icon={ListChecks} label="ready" value={summary.byStatus.TODO ?? 0} title="Status: To do"
            active={query.status === "TODO"} href={filterHref({ status: query.status === "TODO" ? null : "TODO" })} />
          <Pill icon={PlayCircle} label={<>in flight{blocked > 0 && <span className="text-danger"> · {blocked} blocked</span>}</>} value={inFlight} tone="accent"
            title="In progress, in review or blocked" />
          <Pill icon={UserX} label="unassigned" value={summary.unassigned} tone={summary.unassigned ? "warning" : "neutral"}
            active={unassignedActive} href={filterHref({ assignee: unassignedActive ? { kind: "any" } : { kind: "unassigned" } })} />
          <Pill icon={Ruler} label="not estimated" value={summary.unestimated} tone={summary.unestimated ? "warning" : "neutral"} />
        </div>
      </div>

      {summary.epics.length > 0 && (
        <nav aria-label="Epics" className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <ul className="flex min-w-max gap-2">
            {summary.epics.map((epic) => {
              const active = query.epic.kind === "epic" && query.epic.id === epic.id;
              return (
                <li key={epic.id}>
                  <Link
                    href={filterHref({ epic: active ? { kind: "any" } : { kind: "epic", id: epic.id } })}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "inline-flex h-8 items-center gap-2 rounded-full border py-1 pr-1.5 pl-1 text-xs font-medium whitespace-nowrap transition-colors duration-100",
                      active ? "border-accent/50 bg-accent/10 text-accent" : "border-border bg-surface text-text-secondary hover:border-border-strong hover:text-text-primary",
                    )}
                  >
                    <WorkTypeIcon type="EPIC" className="size-6 rounded-full" />
                    <span className="max-w-56 truncate">{epic.label}</span>
                    <span className="rounded-full bg-surface-muted px-1.5 py-0.5 tabular-nums">
                      {epic.count}{epic.estimate ? <span className="text-text-muted"> · {formatPoints(epic.estimate)} pts</span> : null}
                    </span>
                  </Link>
                </li>
              );
            })}
            {summary.withoutEpic > 0 && (
              <li>
                <Link
                  href={filterHref({ epic: query.epic.kind === "none" ? { kind: "any" } : { kind: "none" } })}
                  aria-current={query.epic.kind === "none" ? "true" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center gap-2 rounded-full border border-dashed px-3 text-xs font-medium whitespace-nowrap",
                    query.epic.kind === "none" ? "border-accent/50 bg-accent/10 text-accent" : "border-border text-text-secondary hover:text-text-primary",
                  )}
                >
                  No epic <span className="rounded-full bg-surface-muted px-1.5 py-0.5 tabular-nums">{summary.withoutEpic}</span>
                </Link>
              </li>
            )}
          </ul>
        </nav>
      )}
    </section>
  );
}
