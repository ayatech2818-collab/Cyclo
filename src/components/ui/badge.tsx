import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/*
 * Badge family (Phase 8H): one shape for every state pill (status, role,
 * priority, archived), plus KeyTag for identifiers and CountBadge for numbers.
 * Orange (accent) means attention; indigo (primary) means in progress.
 */

export type BadgeTone = "neutral" | "muted" | "primary" | "accent" | "success" | "warning" | "danger" | "outline";

const TONES: Record<BadgeTone, { pill: string; dot: string }> = {
  neutral: { pill: "bg-text-secondary/10 text-text-secondary", dot: "bg-text-muted" },
  muted: { pill: "bg-surface-muted text-text-secondary", dot: "bg-text-muted" },
  primary: { pill: "bg-primary/10 text-primary", dot: "bg-primary" },
  accent: { pill: "bg-accent/10 text-accent", dot: "bg-accent" },
  success: { pill: "bg-success/10 text-success", dot: "bg-success" },
  warning: { pill: "bg-warning/10 text-warning", dot: "bg-warning" },
  danger: { pill: "bg-danger/10 text-danger", dot: "bg-danger" },
  outline: { pill: "border border-border bg-surface text-text-secondary", dot: "bg-text-muted" },
};

export const BADGE_BASE = "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap";

export function Badge({ tone = "neutral", dot = false, pulse = false, icon: Icon, className, children }: {
  tone?: BadgeTone;
  /** A small status dot before the label. */
  dot?: boolean;
  pulse?: boolean;
  icon?: LucideIcon;
  className?: string;
  children: ReactNode;
}) {
  const style = TONES[tone];
  return (
    <span className={cn(BADGE_BASE, style.pill, className)}>
      {dot && <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", style.dot, pulse && "motion-safe:animate-pulse")} />}
      {Icon && <Icon aria-hidden="true" className="size-3.5 shrink-0" />}
      {children}
    </span>
  );
}

/** Identifier tag (project key, issue key prefix). */
export function KeyTag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 items-center rounded-md bg-accent/10 px-2 font-mono text-xs font-semibold tracking-wide text-accent", className)}>
      {children}
    </span>
  );
}

/** Orange count for attention (unread, pending). Hidden at zero; 99+ above 99. */
export function CountBadge({ count, className, label }: { count: number; className?: string; label?: string }) {
  if (count <= 0) return null;
  return (
    <span aria-label={label} className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-action px-1.5 text-[11px] leading-none font-bold text-primary-foreground tabular-nums", className)}>
      {count > 99 ? "99+" : count}
    </span>
  );
}
