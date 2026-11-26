"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Loader2, Search, X } from "lucide-react";

import { control } from "@/features/projects/components/styles";
import { cn } from "@/lib/utils/cn";

import { searchParentsAction } from "../actions";
import { PARENT_TYPES, TYPE_LABELS, type ParentOption, type WorkItemType } from "../types";
import { IssueKey, WorkTypeIcon } from "./work-badges";

export type SelectedParent = { id: string; issueKey: string; title: string; type: WorkItemType };

/**
 * Searchable parent selector. Candidates come from the database (allowed
 * parent types for `childType`, same project, not archived). Renders a hidden
 * input `name` with the selected id for form submission.
 */
export function ParentPicker({ projectId, childType, excludeId, value, onChange, name, invalid, describedBy, disabled }: {
  projectId: string;
  childType: WorkItemType;
  excludeId?: string | null;
  value: SelectedParent | null;
  onChange: (value: SelectedParent | null) => void;
  name?: string;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ParentOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [pending, startTransition] = useTransition();
  const request = useRef(0);
  const id = useId();
  const allowed = PARENT_TYPES[childType].allowed;

  useEffect(() => {
    if (!open || allowed.length === 0) return;
    const timer = setTimeout(() => {
      const current = ++request.current;
      startTransition(async () => {
        const result = await searchParentsAction(projectId, childType, query, excludeId ?? null);
        if (current !== request.current) return;
        setOptions(result.options);
        setError(result.error);
        setActive(0);
      });
    }, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [open, query, projectId, childType, excludeId, allowed.length]);

  if (allowed.length === 0) {
    return <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-secondary">{TYPE_LABELS[childType]}s are top-level and have no parent.</p>;
  }

  const choose = (option: ParentOption) => {
    onChange(option);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="relative">
      {name && <input type="hidden" name={name} value={value?.id ?? ""} />}
      {value ? (
        <div className={cn(control, "flex items-center gap-2")} aria-describedby={describedBy}>
          <WorkTypeIcon type={value.type} />
          <IssueKey issueKey={value.issueKey} />
          <span className="min-w-0 flex-1 truncate">{value.title}</span>
          <button type="button" disabled={disabled} onClick={() => onChange(null)} className="rounded p-1 text-text-secondary hover:bg-surface-muted hover:text-text-primary" aria-label={`Remove parent ${value.issueKey}`}>
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-secondary" />
          <input
            type="search"
            role="combobox"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            aria-activedescendant={open && options[active] ? `${id}-${options[active].id}` : undefined}
            disabled={disabled}
            value={query}
            maxLength={100}
            placeholder={`Search ${allowed.map((type) => TYPE_LABELS[type].toLowerCase() + "s").join(" or ")}…`}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, options.length - 1)); }
              else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
              else if (event.key === "Enter" && open && options[active]) { event.preventDefault(); choose(options[active]); }
              else if (event.key === "Escape") setOpen(false);
            }}
            className={cn(control, "pl-9")}
          />
          {pending && <Loader2 aria-hidden="true" className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-text-secondary" />}
        </div>
      )}

      {open && !value && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
          {error ? (
            <p role="alert" className="px-3 py-3 text-sm text-danger">{error}</p>
          ) : options.length === 0 ? (
            <p className="px-3 py-3 text-sm text-text-secondary">{pending ? "Searching…" : "No matching work items."}</p>
          ) : (
            <ul id={`${id}-list`} role="listbox" className="max-h-64 overflow-y-auto py-1">
              {options.map((option, index) => (
                <li
                  key={option.id}
                  id={`${id}-${option.id}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(event) => { event.preventDefault(); choose(option); }}
                  onMouseEnter={() => setActive(index)}
                  className={cn("flex cursor-pointer items-center gap-2 px-3 py-2 text-sm", index === active && "bg-primary/10")}
                >
                  <WorkTypeIcon type={option.type} />
                  <IssueKey issueKey={option.issueKey} />
                  <span className="min-w-0 flex-1 truncate">{option.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
