import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { AppRole } from "@/features/auth/access";

import { ROLE_LABELS } from "../types";

const ROLE_TONES: Record<AppRole, BadgeTone> = {
  SUPER_ADMIN: "primary",
  PROJECT_MANAGER: "warning",
  DEVELOPER: "neutral",
};

export function RoleBadge({ role }: { role: AppRole }) {
  return <Badge tone={ROLE_TONES[role]}>{ROLE_LABELS[role]}</Badge>;
}

export function EmployeeStatusBadge({ isActive }: { isActive: boolean }) {
  return <Badge tone={isActive ? "success" : "danger"} dot>{isActive ? "Active" : "Inactive"}</Badge>;
}
