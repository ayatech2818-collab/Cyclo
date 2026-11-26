import Link from "next/link";
import { Inbox, ListChecks, PlayCircle, Ruler, UserX, Layers } from "lucide-react";

import { cn } from "@/lib/utils/cn";

import { backlogHref, formatPoints } from "../logic";
import type { BacklogQuery, BacklogSummary } from "../types";

function Stat({ icon: Icon, label, value, hint, href, tone = "neutral" }: {
  icon: typeof Inbox;
  label: string;
  value: number;
  hint?: string;
  href?: string;
  tone?: "neutral" | "primary" | "accent" | "warning";
}) {
  const tones = {
    neutral: "bg-surface-muted text-text-secondary",
    primary: "bg-primary/10 text-primary",
    accent: "bg-accent/10 text-accent",
    warning: "bg-warning/10 text-warning",
  };
  const body = (
    <>
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", tones[tone])}>
        <Icon aria-hidden="true" className="size-4.5" />
      </span>
      <span className="min-w-0">
        <span className="block text-xl leading-tight font-semibold tabular-nums">{value}</span>
        <span className="block truncate text-xs text-text-secondary">{label}{hint ? ` · ${hint}` : ""}</span>
      </span>
    </>
  );
  const className = "flex items-center gap-3 rounded-xl border border-border bg-surface p-3.5 shadow-sm";
  return href ? <Link href={href} className={cn(className, "hover:border-primary/40")}>{body}</Link> : <div className={className}>{body}</div>;
}

/** Backlog health at a glance. Counts cover open (not done/cancelled) stories, tasks and bugs. */
export function BacklogSummaryPanel({ projectId, query, summary }: { projectId: string; query: BacklogQuery; summary: BacklogSummary }) {
  const inFlight = (summary.byStatus.IN_PROGRESS ?? 0) + (summary.byStatus.IN_REVIEW ?? 0) + (summary.byStatus.BLOCKED ?? 0);
  const filterHref = (overrides: Partial<BacklogQuery>) => backlogHref(projectId, query, { ...overrides, page: 1 });

  return (
    <section aria-label="Backlog summary" className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat icon={Layers} label="Open items" value={summary.total} hint={`${formatPoints(summary.estimate)} pts`} tone="primary" />
        <Stat icon={Inbox} label="Waiting for planning" value={summary.byStatus.BACKLOG ?? 0} href={filterHref({ status: "BACKLOG" })} />
        <Stat icon={ListChecks} label="Ready (to do)" value={summary.byStatus.TODO ?? 0} href={filterHref({ status: "TODO" })} />
        <Stat icon={PlayCircle} label="In flight" value={inFlight} hint={summary.byStatus.BLOCKED ? `${summary.byStatus.BLOCKED} blocked` : undefined} tone="accent" />
        <Stat icon={UserX} label="Unassigned" value={summary.unassigned} href={filterHref({ assignee: { kind: "unassigned" } })} tone={summary.unassigned ? "warning" : "neutral"} />
        <Stat icon={Ruler} label="Not estimated" value={summary.unestimated} />
      </div>

      {summary.epics.length > 0 && (
        <nav aria-label="Epics" className="flex gap-2 overflow-x-auto pb-1">
          {summary.epics.map((epic) => {
            const active = query.epic.kind === "epic" && query.epic.id === epic.id;
            return (
              <Link
                key={epic.id}
                href={filterHref({ epic: active ? { kind: "any" } : { kind: "epic", id: epic.id } })}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium whitespace-nowrap",
                  active ? "border-primary bg-primary/10 text-primary" : "border-border bg-surface text-text-secondary hover:text-text-primary",
                )}
              >
                <span className="max-w-56 truncate">{epic.label}</span>
                <span className="rounded-full bg-surface-muted px-1.5 tabular-nums">{epic.count}</span>
              </Link>
            );
          })}
          {summary.withoutEpic > 0 && (
            <Link
              href={filterHref({ epic: query.epic.kind === "none" ? { kind: "any" } : { kind: "none" } })}
              aria-current={query.epic.kind === "none" ? "true" : undefined}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 rounded-full border border-dashed px-3 py-1 text-xs font-medium whitespace-nowrap",
                query.epic.kind === "none" ? "border-primary bg-primary/10 text-primary" : "border-border text-text-secondary hover:text-text-primary",
              )}
            >
              No epic <span className="rounded-full bg-surface-muted px-1.5 tabular-nums">{summary.withoutEpic}</span>
            </Link>
          )}
        </nav>
      )}
    </section>
  );
}
