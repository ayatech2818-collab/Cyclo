"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AtSign, Loader2 } from "lucide-react";

import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { cn } from "@/lib/utils/cn";

import { searchMentionsAction } from "../actions";
import {
  COMMENT_MAX, insertMention, mentionQueryAt, toStoredBody, validateStoredBody,
  type CommentMention, type MentionCandidate, type MentionQuery,
} from "../logic";

const ROLE_LABELS: Record<MentionCandidate["role"], string> = { SUPER_ADMIN: "Super Admin", PROJECT_MANAGER: "Project Manager", DEVELOPER: "Developer" };
const SEARCH_DELAY = 200;

/**
 * Comment editor with @mention autocomplete. Typing "@" searches (debounced,
 * server-authorized) the people who can access this project; picking one
 * inserts "@Full Name" and remembers the person, so only picked names become
 * mentions. `onSubmit` receives the stored body and resolves true on success;
 * on failure the text stays (or is restored) for another try.
 */
export function CommentComposer({
  workItemId, initialText = "", initialPicked = [], submitLabel, placeholder, autoFocus = false, compact = false, onSubmit, onCancel,
}: {
  workItemId: string;
  initialText?: string;
  initialPicked?: CommentMention[];
  submitLabel: string;
  placeholder: string;
  autoFocus?: boolean;
  compact?: boolean;
  onSubmit: (body: string, picked: CommentMention[]) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initialText);
  const [picked, setPicked] = useState<CommentMention[]>(initialPicked);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Autocomplete
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [results, setResults] = useState<MentionCandidate[]>([]);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const cache = useRef(new Map<string, MentionCandidate[]>());
  const latest = useRef(0);
  const open = mention !== null;

  useEffect(() => {
    if (!mention) return;
    const key = mention.query.trim().toLowerCase();
    const cached = cache.current.get(key);
    if (cached) {
      setResults(cached);
      setSearching(false);
      return;
    }
    const request = ++latest.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      let result;
      try {
        result = await searchMentionsAction(workItemId, key);
      } catch {
        result = { ok: false as const, error: "People could not be searched." };
      }
      if (request !== latest.current) return; // a newer query is in flight
      setSearching(false);
      if (result.ok) {
        cache.current.set(key, result.page);
        setResults(result.page);
        setSearchError(null);
      } else {
        setResults([]);
        setSearchError(result.error);
      }
    }, SEARCH_DELAY);
    return () => clearTimeout(timer);
  }, [mention, workItemId]);

  const stored = toStoredBody(text, picked);
  const problem = validateStoredBody(stored);
  const tooLong = stored.length > COMMENT_MAX;

  const track = (value: string, caret: number) => {
    const next = mentionQueryAt(value, caret);
    setMention(next);
    if (!next || next.query !== mention?.query) setActive(0);
  };

  const choose = (person: MentionCandidate) => {
    const element = textarea.current;
    if (!element || !mention) return;
    const next = insertMention(text, element.selectionStart, mention, person.name);
    setText(next.text);
    setPicked((current) => (current.some((entry) => entry.id === person.id) ? current : [...current, { id: person.id, name: person.name }]));
    setMention(null);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  };

  async function submit() {
    if (submitting) return;
    if (problem) {
      setError(problem === "empty" ? "Write a comment first." : problem === "too_long" ? `Comments can be up to ${COMMENT_MAX.toLocaleString("en")} characters.` : "Mention at most 20 people in one comment.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const previous = { text, picked };
    // Optimistic: clear at once; the parent shows the comment while it saves.
    if (!initialText) {
      setText("");
      setPicked([]);
    }
    const ok = await onSubmit(stored, picked);
    setSubmitting(false);
    if (!ok) {
      setText(previous.text);
      setPicked(previous.picked);
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && results.length > 0) {
      if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => (index + 1) % results.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => (index - 1 + results.length) % results.length); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); choose(results[Math.min(active, results.length - 1)]); return; }
    }
    if (open && event.key === "Escape") { event.preventDefault(); setMention(null); return; }
    if (event.key === "Escape" && onCancel) { event.preventDefault(); onCancel(); return; }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
  };

  const listId = `${id}-mentions`;
  return (
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="relative">
      <label htmlFor={`${id}-text`} className="sr-only">{placeholder}</label>
      <textarea
        ref={textarea}
        id={`${id}-text`}
        autoFocus={autoFocus}
        rows={compact ? 2 : 3}
        value={text}
        placeholder={placeholder}
        onChange={(event) => { setText(event.target.value); setError(null); track(event.target.value, event.target.selectionStart); }}
        onSelect={(event) => track(event.currentTarget.value, event.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setMention(null), 150)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && results[active] ? `${listId}-${results[active].id}` : undefined}
        aria-invalid={Boolean(error) || tooLong}
        aria-describedby={`${id}-hint`}
        className="block min-h-16 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-text-primary placeholder:text-text-muted focus-visible:border-primary aria-[invalid=true]:border-danger"
      />

      {open && (
        <div className="absolute inset-x-0 z-30 mt-1 overflow-hidden rounded-lg border border-border bg-surface shadow-lg sm:right-auto sm:w-80">
          <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs text-text-muted">
            <AtSign aria-hidden="true" className="size-3.5" />
            {mention.query ? <>People matching “{mention.query}”</> : "People on this project"}
            {searching && <Loader2 aria-label="Searching" className="ml-auto size-3.5 animate-spin" />}
          </div>
          <ul id={listId} role="listbox" aria-label="Mention someone" className="max-h-64 overflow-y-auto p-1">
            {results.map((person, index) => (
              <li
                key={person.id}
                id={`${listId}-${person.id}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => { event.preventDefault(); choose(person); }}
                onMouseEnter={() => setActive(index)}
                className={cn("flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm", index === active ? "bg-primary/10" : "hover:bg-surface-muted")}
              >
                <EmployeeAvatar fullName={person.name} email={null} avatarUrl={null} avatar={person.avatar} size="sm" />
                <span className="min-w-0 flex-1 truncate font-medium">{person.name}</span>
                <span className="shrink-0 text-xs text-text-muted">{person.isProjectManager ? "Project PM" : ROLE_LABELS[person.role]}</span>
              </li>
            ))}
            {!searching && results.length === 0 && (
              <li role="presentation" className="px-2 py-2 text-xs text-text-muted">{searchError ?? "No one on this project matches."}</li>
            )}
          </ul>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p id={`${id}-hint`} aria-live="polite" className={cn("mr-auto text-xs", error || tooLong ? "text-danger" : "text-text-muted")}>
          {error ?? (tooLong ? `Too long: ${stored.length.toLocaleString("en")} / ${COMMENT_MAX.toLocaleString("en")} characters` : <>Type <kbd className="font-mono">@</kbd> to mention someone · <span className="hidden sm:inline">Ctrl+Enter to send</span></>)}
        </p>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={submitting} className="inline-flex h-8 items-center rounded-md px-3 text-xs font-medium text-text-secondary hover:bg-surface-muted disabled:opacity-60">
            Cancel
          </button>
        )}
        <button type="submit" disabled={submitting || problem === "empty"}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow-sm hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60">
          {submitting && <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
