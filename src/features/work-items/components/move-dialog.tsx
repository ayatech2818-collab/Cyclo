"use client";

import { useEffect, useId, useRef, useState } from "react";

import { label, primaryButton, secondaryButton } from "@/features/projects/components/styles";
import { cn } from "@/lib/utils/cn";

import { parseReason, REASON_MAX, REASON_MIN, type Move } from "../execution";

export type PendingMove = { move: Move; itemKey: string; itemTitle: string };

const REASON_PROMPTS: Record<string, { title: string; hint: string; placeholder: string }> = {
  block: { title: "Mark blocked", hint: "What is blocking this work? Everyone on the project can see the reason.", placeholder: "e.g. Waiting for the payment API credentials" },
  reject: { title: "Request changes", hint: "What needs to change? The item goes back to In progress.", placeholder: "e.g. Validation is missing on the email field" },
};

/**
 * Confirmation or reason prompt for one move (native <dialog>: focus trap,
 * Escape to cancel). onSubmit receives the trimmed reason (or null).
 */
export function MoveDialog({ pending, onCancel, onSubmit }: { pending: PendingMove | null; onCancel: () => void; onSubmit: (reason: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (pending && !element.open) element.showModal();
    if (!pending && element.open) element.close();
  }, [pending]);

  if (!pending) return <dialog ref={dialog} className="hidden" />;
  const { move } = pending;
  const prompt = move.needsReason && move.action ? REASON_PROMPTS[move.action] : null;
  const parsed = parseReason(reason);
  const invalid = prompt !== null && parsed === null;

  const submit = () => {
    setTouched(true);
    if (invalid) return;
    onSubmit(prompt ? parsed : null);
    setReason("");
    setTouched(false);
  };
  const cancel = () => {
    setReason("");
    setTouched(false);
    onCancel();
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      onCancel={(event) => { event.preventDefault(); cancel(); }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-border bg-surface p-6 text-text-primary shadow-xl backdrop:bg-black/40"
    >
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <h2 id={`${id}-title`} className="font-semibold">{prompt?.title ?? move.label}</h2>
        <p className="mt-1 text-sm text-text-secondary"><span className="font-mono text-xs">{pending.itemKey}</span> · {pending.itemTitle}</p>
        {prompt ? (
          <div className="mt-4">
            <label htmlFor={`${id}-reason`} className={label}>Reason</label>
            <textarea
              id={`${id}-reason`}
              autoFocus
              rows={3}
              maxLength={REASON_MAX}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              onBlur={() => setTouched(true)}
              placeholder={prompt.placeholder}
              aria-invalid={touched && invalid}
              aria-describedby={`${id}-hint`}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm focus-visible:border-primary aria-[invalid=true]:border-danger"
            />
            <p id={`${id}-hint`} className={cn("mt-1.5 text-xs", touched && invalid ? "text-danger" : "text-text-muted")}>
              {touched && invalid ? `Use ${REASON_MIN}–${REASON_MAX} characters.` : prompt.hint}
              <span className="float-right tabular-nums">{reason.trim().length}/{REASON_MAX}</span>
            </p>
          </div>
        ) : (
          <p className="mt-4 text-sm">{move.confirm}</p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" autoFocus={!prompt} onClick={cancel} className={cn(secondaryButton, "h-9")}>Cancel</button>
          <button type="submit" className={cn(primaryButton, "h-9", move.tone === "danger" && "bg-danger text-danger-foreground hover:bg-danger-hover")}>
            {prompt?.title ?? move.label}
          </button>
        </div>
      </form>
    </dialog>
  );
}
