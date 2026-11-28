import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

import { fieldError, hint, label } from "./styles";

/**
 * Label, control, hint and error in one consistent stack. The control is
 * passed as children and should use `control` / `textareaControl` and point
 * `aria-describedby` at `${id}-hint` / `${id}-error` when they exist.
 */
export function Field({ id, label: text, hint: hintText, error, className, children }: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className={label}>{text}</label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className={fieldError}>{error}</p>
      ) : hintText ? (
        <p id={`${id}-hint`} className={hint}>{hintText}</p>
      ) : null}
    </div>
  );
}

/** Small uppercase group label (sidebar groups, filter groups, list sections). */
export function GroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-[11px] font-semibold tracking-wider text-text-muted uppercase", className)}>{children}</p>;
}
