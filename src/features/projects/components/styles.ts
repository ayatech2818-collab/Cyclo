/** Shared class names for project UI (built on the existing design tokens). */

export const primaryButton =
  "inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60";

export const secondaryButton =
  "inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium text-text-primary hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60";

export const dangerButton =
  "inline-flex h-10 items-center justify-center gap-2 rounded-md border border-danger/30 bg-surface px-4 text-sm font-medium text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-60";

export const control =
  "h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-text-primary focus-visible:border-primary aria-[invalid=true]:border-danger disabled:opacity-60";

export const label = "mb-1.5 block text-sm font-medium text-text-primary";

export const card = "rounded-xl border border-border bg-surface shadow-sm";
