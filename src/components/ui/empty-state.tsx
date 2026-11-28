import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/** Empty, "not found" and error state block (was StatePanel in the employees feature). */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = "neutral",
  compact = false,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "danger" | "success";
  /** Smaller padding for use inside a panel. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={cn(
        "flex flex-col items-center rounded-xl border border-dashed border-border bg-surface text-center",
        compact ? "px-5 py-8" : "px-6 py-14",
        className,
      )}
    >
      <span className={cn(
        "mb-4 rounded-full p-3",
        tone === "danger" ? "bg-danger/10 text-danger" : tone === "success" ? "bg-success/10 text-success" : "bg-primary/10 text-primary",
        compact && "mb-3 p-2.5",
      )}>
        <Icon aria-hidden="true" className={compact ? "size-5" : "size-6"} />
      </span>
      <h2 className={cn("font-semibold", compact ? "text-sm" : "text-base")}>{title}</h2>
      <p className={cn("mt-1 max-w-sm text-text-secondary", compact ? "text-xs" : "text-sm")}>{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
