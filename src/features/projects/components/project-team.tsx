"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Loader2, Search, UserMinus, UserPlus, X } from "lucide-react";

import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { cn } from "@/lib/utils/cn";

import { addProjectMemberAction, removeProjectMemberAction, searchDevelopersAction, type ProjectFormState } from "../actions";
import type { DeveloperOption } from "../types";
import { SEARCH_MAX_LENGTH } from "../validation";
import { control, dangerButton, primaryButton, secondaryButton } from "./styles";

const SEARCH_DELAY_MS = 250;

function optionName(option: { fullName: string | null; email: string | null }) {
  return option.fullName?.trim() || option.email || "Unnamed developer";
}

function Message({ state }: { state: ProjectFormState | null }) {
  return (
    <div aria-live="polite" className="text-sm">
      {state?.error && <p role="alert" className="text-danger">{state.error}</p>}
      {state?.success && <p role="status" className="text-success">{state.success}</p>}
    </div>
  );
}

/**
 * Searchable selector for adding developers. Candidates come from the database
 * (active DEVELOPERs not already on the team), so inactive employees and other
 * roles are never offered; the add RPC re-checks the same rules.
 */
export function AddDeveloperPicker({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<DeveloperOption[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<ProjectFormState | null>(null);
  const [searching, startSearch] = useTransition();
  const [adding, startAdd] = useTransition();
  const [addingId, setAddingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const listId = useId();

  const runSearch = (text: string) => {
    const request = ++requestRef.current;
    startSearch(async () => {
      const response = await searchDevelopersAction(projectId, text);
      if (request !== requestRef.current) return; // a newer search superseded this one
      setOptions(response.options);
      setSearchError(response.error);
      setActive(0);
      setLoaded(true);
    });
  };

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => runSearch(query), query ? SEARCH_DELAY_MS : 0);
    return () => clearTimeout(timer);
    // runSearch is recreated each render; query/open are the real triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const add = (option: DeveloperOption) => {
    if (adding) return; // one add at a time; the input stays focusable meanwhile
    setAddingId(option.id);
    startAdd(async () => {
      const response = await addProjectMemberAction(projectId, option.id);
      setResult(response.success ? { ...response, success: `${optionName(option)} was added to the team.` } : response);
      setAddingId(null);
      if (response.success) {
        setQuery("");
        runSearch("");
        inputRef.current?.focus();
      }
    });
  };

  if (!open) {
    return (
      <div className="space-y-2">
        <button type="button" onClick={() => { setOpen(true); setResult(null); }} className={primaryButton}>
          <UserPlus aria-hidden="true" className="size-4" />
          Add developer
        </button>
        <Message state={result} />
      </div>
    );
  }

  const activeOption = options[active];

  return (
    <div className="w-full space-y-3 rounded-xl border border-border bg-surface-muted/40 p-4 sm:w-96">
      <div className="flex items-center justify-between">
        <label htmlFor={`${listId}-input`} className="text-sm font-medium">Add a developer</label>
        <button type="button" onClick={() => setOpen(false)} className="inline-flex size-8 items-center justify-center rounded-md text-text-secondary hover:bg-surface-muted hover:text-text-primary" aria-label="Close developer search">
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-secondary" />
        <input
          ref={inputRef}
          id={`${listId}-input`}
          type="search"
          role="combobox"
          aria-expanded={loaded}
          aria-controls={`${listId}-list`}
          aria-autocomplete="list"
          aria-activedescendant={activeOption ? `${listId}-${activeOption.id}` : undefined}
          autoComplete="off"
          maxLength={SEARCH_MAX_LENGTH}
          placeholder="Search by name or email"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, options.length - 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
            else if (event.key === "Enter" && activeOption) { event.preventDefault(); add(activeOption); }
            else if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
          }}
          className={cn(control, "pl-9")}
        />
        {searching && <Loader2 aria-hidden="true" className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-text-secondary" />}
      </div>

      {searchError ? (
        <p role="alert" className="text-sm text-danger">{searchError}</p>
      ) : !loaded ? (
        <div className="space-y-2" aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => <div key={index} className="h-11 animate-pulse rounded-md bg-border/60" />)}
        </div>
      ) : options.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-text-secondary">
          {query ? "No active developers match this search." : "Every active developer is already on this team."}
        </p>
      ) : (
        <ul id={`${listId}-list`} role="listbox" aria-label="Active developers" className="max-h-72 space-y-1 overflow-y-auto">
          {options.map((option, index) => (
            <li
              key={option.id}
              id={`${listId}-${option.id}`}
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => add(option)}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2",
                index === active ? "bg-primary/10" : "hover:bg-surface-muted",
                adding && "cursor-wait opacity-60",
              )}
            >
              <EmployeeAvatar fullName={option.fullName} email={option.email} avatarUrl={null} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{optionName(option)}</span>
                {option.email && option.fullName && <span className="block truncate text-xs text-text-secondary">{option.email}</span>}
              </span>
              {addingId === option.id ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin text-primary" />
              ) : (
                <UserPlus aria-hidden="true" className="size-4 text-text-muted" />
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-text-secondary">Only active developers who are not on the team are listed. Use ↑ ↓ and Enter to add.</p>
      <Message state={result} />
    </div>
  );
}

/** Remove a developer, with an inline confirmation step. */
export function RemoveMemberButton({ projectId, profileId, name }: { projectId: string; profileId: string; name: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<ProjectFormState | null>(null);
  const [pending, startTransition] = useTransition();

  const remove = () =>
    startTransition(async () => {
      const response = await removeProjectMemberAction(projectId, profileId);
      setState(response);
      if (!response.success) setConfirming(false);
    });

  return (
    <div className="flex flex-col items-end gap-1.5">
      {confirming ? (
        <div role="group" aria-label={`Confirm removing ${name}`} className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-text-secondary">Remove {name}?</span>
          <button type="button" disabled={pending} onClick={remove} className={cn(dangerButton, "h-8 border-danger bg-danger px-3 text-danger-foreground hover:bg-danger-hover")}>
            {pending ? "Removing…" : "Remove"}
          </button>
          <button type="button" disabled={pending} onClick={() => setConfirming(false)} className={cn(secondaryButton, "h-8 px-3")}>Cancel</button>
        </div>
      ) : (
        <button type="button" onClick={() => { setConfirming(true); setState(null); }} className={cn(secondaryButton, "h-8 px-3 text-text-secondary hover:text-danger")} aria-label={`Remove ${name} from the team`}>
          <UserMinus aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">Remove</span>
        </button>
      )}
      {state?.error && <p role="alert" className="text-xs text-danger">{state.error}</p>}
    </div>
  );
}
