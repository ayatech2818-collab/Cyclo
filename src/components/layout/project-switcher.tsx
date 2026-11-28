"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronsUpDown, FolderKanban, Loader2, Search } from "lucide-react";

import { KeyTag } from "@/components/ui/badge";
import { searchProjectsAction, type ProjectSummary } from "@/features/projects/switcher-actions";
import { cn } from "@/lib/utils/cn";

import { useCurrentProject } from "./current-project";
import { switchTarget } from "./navigation";

/**
 * Current project switcher: a searchable list of the projects you can access
 * (the same database-scoped list as the Projects page). Picking one keeps you
 * in the same section when you are already inside a project.
 */
export function ProjectSwitcher({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  const { project, loading, select } = useCurrentProject();
  const router = useRouter();
  const pathname = usePathname();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProjectSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const latest = useRef(0);

  useEffect(() => {
    if (!open) return;
    const request = ++latest.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      const result = await searchProjectsAction(query).catch(() => ({ ok: false as const, error: "Projects could not be loaded." }));
      if (request !== latest.current) return;
      setSearching(false);
      if (result.ok) {
        setResults(result.projects);
        setTotal(result.total);
        setError(null);
      } else {
        setError(result.error);
      }
    }, query ? 200 : 0);
    return () => clearTimeout(timer);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onPointer = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const choose = (next: ProjectSummary) => {
    select(next);
    setOpen(false);
    onNavigate?.();
    router.push(switchTarget(pathname, next.id));
  };

  return (
    <div ref={wrapper} className="relative">
      <button ref={trigger} type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined}
        aria-label={project ? `Current project: ${project.name}. Switch project` : "Choose a project"} title={compact ? (project?.name ?? "Choose a project") : undefined}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface text-left transition-colors duration-100 hover:border-border-strong hover:bg-surface-muted",
          compact ? "size-11 justify-center p-0" : "p-2",
        )}>
        {project ? (
          <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary-soft font-mono text-[11px] font-bold text-primary-strong">
            {project.projectKey.slice(0, 4)}
          </span>
        ) : (
          <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-muted text-text-muted">
            <FolderKanban className="size-4" />
          </span>
        )}
        {!compact && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{project ? project.name : "Choose a project"}</span>
              <span className="block truncate text-xs text-text-muted">{loading ? "Loading…" : project ? (project.archived ? "Archived · switch project" : "Switch project") : "Pick one to see its sections"}</span>
            </span>
            {loading ? <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin text-text-muted" /> : <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-text-muted" />}
          </>
        )}
      </button>

      {open && (
        <div id={`${id}-panel`} role="dialog" aria-label="Switch project"
          className={cn(
            "absolute z-50 w-72 overflow-hidden rounded-xl border border-border bg-surface shadow-lg",
            compact ? "top-0 left-full ml-3" : "top-full left-0 mt-2 w-full min-w-64",
          )}>
          <div className="relative border-b border-border p-2">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-4.5 size-4 -translate-y-1/2 text-text-muted" />
            <label htmlFor={`${id}-search`} className="sr-only">Search projects</label>
            <input ref={input} id={`${id}-search`} type="search" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={100}
              placeholder="Search projects" autoComplete="off"
              className="h-9 w-full rounded-md bg-surface-muted pr-3 pl-8 text-sm placeholder:text-text-muted focus-visible:outline-2" />
          </div>
          <ul className="max-h-72 overflow-y-auto overscroll-contain p-1.5" aria-busy={searching}>
            {results === null && searching && (
              <li className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-text-muted"><Loader2 aria-hidden="true" className="size-4 animate-spin" />Loading…</li>
            )}
            {error && <li role="alert" className="px-3 py-4 text-sm text-danger">{error}</li>}
            {results?.length === 0 && !searching && !error && (
              <li className="px-3 py-6 text-center text-sm text-text-muted">{query ? "No projects match." : "You are not on any project yet."}</li>
            )}
            {results?.map((entry) => (
              <li key={entry.id}>
                <button type="button" onClick={() => choose(entry)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-muted focus-visible:bg-surface-muted">
                  <KeyTag className="h-5 shrink-0 bg-primary-soft px-1.5 text-[11px] text-primary-strong">{entry.projectKey}</KeyTag>
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.id === project?.id && <Check aria-label="Current" className="size-4 shrink-0 text-primary-strong" />}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs">
            <span className="text-text-muted">{results ? `${Math.min(results.length, total)} of ${total}` : ""}</span>
            <Link href="/projects" onClick={() => { setOpen(false); onNavigate?.(); }} className="font-medium text-primary-strong hover:underline">All projects</Link>
          </div>
        </div>
      )}
    </div>
  );
}
