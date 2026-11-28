import { Archive, ArrowDown, ArrowUp, ChevronsUp, Minus } from "lucide-react";

import { Badge, KeyTag, type BadgeTone } from "@/components/ui/badge";

import { PRIORITY_LABELS, STATUS_LABELS, type ProjectPriority, type ProjectStatus } from "../types";

const STATUS_TONES: Record<ProjectStatus, BadgeTone> = {
  planning: "neutral",
  active: "success",
  on_hold: "warning",
  completed: "primary",
  cancelled: "danger",
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return <Badge tone={STATUS_TONES[status]} dot>{STATUS_LABELS[status]}</Badge>;
}

const PRIORITY_STYLES: Record<ProjectPriority, { className: string; icon: typeof Minus }> = {
  low: { className: "text-text-secondary", icon: ArrowDown },
  medium: { className: "text-primary", icon: Minus },
  high: { className: "text-accent", icon: ArrowUp },
  critical: { className: "border-accent/30 bg-accent/10 text-accent", icon: ChevronsUp },
};

/** Work-item and project priority (shared). Outlined so it reads as a property, not a state. */
export function ProjectPriorityBadge({ priority }: { priority: ProjectPriority }) {
  const { className, icon } = PRIORITY_STYLES[priority];
  return (
    <Badge tone="outline" icon={icon} className={className}>
      <span>
        <span className="sr-only">Priority: </span>
        {PRIORITY_LABELS[priority]}
      </span>
    </Badge>
  );
}

export function ProjectKeyBadge({ projectKey, className }: { projectKey: string; className?: string }) {
  return <KeyTag className={className}>{projectKey}</KeyTag>;
}

export function ArchivedBadge() {
  return <Badge tone="muted" icon={Archive}>Archived</Badge>;
}
