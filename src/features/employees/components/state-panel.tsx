import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Shared empty / error state block. */
export function StatePanel({
  icon: Icon,
  title,
  description,
  action,
  tone = "neutral",
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  tone?: "neutral" | "danger";
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className="flex flex-col items-center rounded-xl border border-dashed border-border bg-surface px-6 py-14 text-center"
    >
      <span className={tone === "danger" ? "mb-4 rounded-full bg-danger/10 p-3 text-danger" : "mb-4 rounded-full bg-primary/10 p-3 text-primary"}>
        <Icon aria-hidden="true" className="size-6" />
      </span>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-text-secondary">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export const secondaryButton =
  "inline-flex h-9 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium text-text-primary hover:bg-background";
