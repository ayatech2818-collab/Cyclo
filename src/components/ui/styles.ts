import { cn } from "@/lib/utils/cn";

/*
 * CYCLO design system class recipes (Phase 8H). The single source for buttons,
 * form controls and panels; components and the older feature-level style
 * modules build on these. Colours come from the theme tokens in globals.css.
 */

export type ButtonVariant = "primary" | "secondary" | "accent" | "ghost" | "danger" | "danger-solid" | "success";
export type ButtonSize = "sm" | "md" | "lg";

const BUTTON_BASE =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition-colors duration-100 " +
  "disabled:pointer-events-none disabled:opacity-60 aria-disabled:pointer-events-none aria-disabled:opacity-60";

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  lg: "h-10 px-5 text-sm",
};

/**
 * Orange (primary) for the main action on a screen; purple (accent) only for a
 * secondary emphasis, as a soft tint, never competing with the primary fill.
 */
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-action font-semibold text-primary-foreground shadow-sm hover:bg-action-hover",
  secondary: "border border-border bg-surface text-text-primary hover:bg-surface-muted",
  accent: "border border-accent/25 bg-accent/10 text-accent hover:bg-accent/15",
  ghost: "text-text-secondary hover:bg-surface-muted hover:text-text-primary",
  danger: "border border-danger/30 bg-surface text-danger hover:bg-danger/10",
  "danger-solid": "bg-danger text-danger-foreground shadow-sm hover:bg-danger-hover",
  success: "border border-success/40 bg-success/10 text-success hover:bg-success/20",
};

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string): string {
  return cn(BUTTON_BASE, BUTTON_SIZES[size], BUTTON_VARIANTS[variant], className);
}

/** Square-ish round icon button; pair with an aria-label. */
export function iconButtonClass(size: ButtonSize = "md", className?: string): string {
  const box = size === "sm" ? "size-8" : size === "lg" ? "size-10" : "size-9";
  return cn(
    "inline-flex shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors duration-100 hover:bg-surface-muted hover:text-text-primary disabled:pointer-events-none disabled:opacity-60",
    box,
    className,
  );
}

// Pre-built recipes for the most common cases (and the names older code imports).
export const primaryButton = buttonClass("primary");
export const secondaryButton = buttonClass("secondary");
export const dangerButton = buttonClass("danger");
export const ghostButton = buttonClass("ghost");

/** Inputs, selects and textareas share one height (md) and radius. */
export const control =
  "h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-text-primary transition-colors duration-100 " +
  "placeholder:text-text-muted hover:border-border-strong focus-visible:border-primary aria-[invalid=true]:border-danger disabled:opacity-60";

export const textareaControl =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-text-primary transition-colors duration-100 " +
  "placeholder:text-text-muted hover:border-border-strong focus-visible:border-primary aria-[invalid=true]:border-danger disabled:opacity-60";

export const label = "mb-1.5 block text-sm font-medium text-text-primary";
export const hint = "mt-1.5 text-xs text-text-muted";
export const fieldError = "mt-1.5 text-xs text-danger";

/** Page sections and cards: border plus a soft shadow, large radius. */
export const panel = "rounded-xl border border-border bg-surface shadow-sm";
/** Alias kept for existing imports. */
export const card = panel;
