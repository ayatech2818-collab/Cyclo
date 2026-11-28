"use client";

import Link from "next/link";
import { AtSign, BadgeCheck, Check, CornerDownRight, FolderPlus, MessageSquare, OctagonAlert, RotateCcw, SendHorizontal, StepForward, UserCheck, UserCog, type LucideIcon } from "lucide-react";

import { EmployeeAvatar } from "@/features/employees/components/employee-avatar";
import { formatActivityDateTime, relativeTime } from "@/features/projects/activity";
import { cn } from "@/lib/utils/cn";

import { actorLabel, describeNotification, notificationDetail, notificationHref, type Notification, type NotificationEvent } from "../logic";

const EVENT_STYLE: Record<NotificationEvent, { icon: LucideIcon; tone: string }> = {
  MENTIONED: { icon: AtSign, tone: "bg-accent text-accent-foreground" },
  COMMENT_REPLY: { icon: CornerDownRight, tone: "bg-action text-primary-foreground" },
  COMMENT_ADDED: { icon: MessageSquare, tone: "bg-action text-primary-foreground" },
  REPLY_ADDED: { icon: CornerDownRight, tone: "bg-action text-primary-foreground" },
  WORK_ITEM_ASSIGNED: { icon: UserCheck, tone: "bg-accent text-accent-foreground" },
  REVIEW_REQUESTED: { icon: SendHorizontal, tone: "bg-action text-primary-foreground" },
  REVIEW_APPROVED: { icon: BadgeCheck, tone: "bg-success text-surface" },
  REVIEW_CHANGES_REQUESTED: { icon: RotateCcw, tone: "bg-warning text-surface" },
  WORK_ITEM_BLOCKED: { icon: OctagonAlert, tone: "bg-danger text-danger-foreground" },
  WORK_ITEM_RESUMED: { icon: StepForward, tone: "bg-success text-surface" },
  PROJECT_MEMBER_ADDED: { icon: FolderPlus, tone: "bg-action text-primary-foreground" },
  PROJECT_MANAGER_ASSIGNED: { icon: UserCog, tone: "bg-accent text-accent-foreground" },
};

/**
 * One notification. Opening it marks it read and goes to the work item (and
 * comment). Unread rows carry a dot and a tinted background; rows that arrived
 * live in this session fade in.
 */
export function NotificationRow({ notification, now, timeZone, fresh = false, compact = false, onOpen, onMarkRead }: {
  notification: Notification;
  now: Date | null;
  timeZone: string | undefined;
  fresh?: boolean;
  compact?: boolean;
  onOpen: (notification: Notification) => void;
  onMarkRead: (notification: Notification) => void;
}) {
  const { icon: Icon, tone } = EVENT_STYLE[notification.event];
  const href = notificationHref(notification);
  const detail = notificationDetail(notification);
  const unread = !notification.readAt;
  const relative = now ? relativeTime(notification.createdAt, now) : null;
  const when = relative ?? `${formatActivityDateTime(notification.createdAt, timeZone)}${timeZone === "UTC" ? " UTC" : ""}`;
  const summary = `${actorLabel(notification)} ${describeNotification(notification)}`;

  const body = (
    <>
      <span className="relative shrink-0">
        <EmployeeAvatar fullName={notification.actorName} email={null} avatarUrl={null} avatar={notification.actorAvatar} size={compact ? "sm" : "md"} />
        <span className={cn("absolute -right-1 -bottom-1 flex size-4.5 items-center justify-center rounded-full ring-2 ring-surface", tone)}>
          <Icon aria-hidden="true" className="size-2.5" strokeWidth={2.75} />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm leading-snug", unread ? "text-text-primary" : "text-text-secondary")}>
          <span className="font-semibold text-text-primary">{actorLabel(notification)}</span> {describeNotification(notification)}
        </span>
        {detail && <span className="mt-0.5 line-clamp-2 block text-xs break-words text-text-secondary">{detail}</span>}
        <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
          {notification.project && <span className="font-mono">{notification.workItem?.issueKey ?? notification.project.key}</span>}
          {notification.project && <span aria-hidden="true">·</span>}
          {notification.project && <span className="max-w-40 truncate">{notification.project.name}</span>}
          {notification.project && <span aria-hidden="true">·</span>}
          <time dateTime={notification.createdAt} title={formatActivityDateTime(notification.createdAt, timeZone)}>{when}</time>
        </span>
      </span>
    </>
  );

  return (
    <li className={cn(
      "group relative flex items-start gap-1 rounded-lg transition-colors",
      unread ? "bg-primary/[0.06]" : "",
      fresh && "motion-safe:animate-[notification-in_500ms_ease-out]",
    )}>
      {href ? (
        <Link href={href} onClick={() => onOpen(notification)} aria-label={`${summary}${unread ? " (unread)" : ""}`}
          className={cn("flex min-w-0 flex-1 items-start gap-3 rounded-lg hover:bg-surface-muted/70 focus-visible:bg-surface-muted/70", compact ? "p-2.5" : "p-3")}>
          {body}
        </Link>
      ) : (
        <div className={cn("flex min-w-0 flex-1 items-start gap-3", compact ? "p-2.5" : "p-3")}>{body}</div>
      )}
      <div className={cn("flex shrink-0 items-center gap-1", compact ? "pt-2.5 pr-2" : "pt-3 pr-3")}>
        {unread ? (
          <>
            <button type="button" onClick={() => onMarkRead(notification)} title="Mark as read" aria-label={`Mark as read: ${summary}`}
              className="inline-flex size-7 items-center justify-center rounded-md text-text-muted opacity-100 hover:bg-surface-muted hover:text-text-primary sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
              <Check aria-hidden="true" className="size-3.5" />
            </button>
            <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
          </>
        ) : (
          <span className="size-2" aria-hidden="true" />
        )}
      </div>
    </li>
  );
}
