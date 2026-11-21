import type { AppRole } from "@/features/auth/access";
import { cn } from "@/lib/utils/cn";

import { ROLE_LABELS } from "../types";

const badge = "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap";

const roleStyles: Record<AppRole, string> = {
  SUPER_ADMIN: "bg-primary/10 text-primary",
  PROJECT_MANAGER: "bg-warning/10 text-warning",
  DEVELOPER: "bg-text-secondary/10 text-text-secondary",
};

export function RoleBadge({ role }: { role: AppRole }) {
  return <span className={cn(badge, roleStyles[role])}>{ROLE_LABELS[role]}</span>;
}

export function EmployeeStatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <span className={cn(badge, isActive ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", isActive ? "bg-success" : "bg-danger")} />
      {isActive ? "Active" : "Inactive"}
    </span>
  );
}
