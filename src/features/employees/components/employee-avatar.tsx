import { cn } from "@/lib/utils/cn";
import { EMOJI_AVATARS } from "@/features/profile/avatar-catalog";
import { AVATAR_ICON_COMPONENTS } from "@/features/profile/avatar-icons";
import type { ResolvedAvatar } from "@/features/profile/avatar";

import { initials, safeAvatarUrl } from "../format";

const sizes = {
  sm: { box: "size-8 text-xs", emoji: "text-base", icon: "size-4" },
  md: { box: "size-10 text-sm", emoji: "text-xl", icon: "size-5" },
  lg: { box: "size-16 text-lg", emoji: "text-3xl", icon: "size-8" },
  xl: { box: "size-24 text-2xl", emoji: "text-5xl", icon: "size-12" },
} as const;

/**
 * Decorative avatar: the employee's name is always rendered next to it.
 * `avatar` is the server-resolved selection (Phase 6). Without it, the
 * administrator-managed avatarUrl or initials are shown, as before.
 */
export function EmployeeAvatar({
  fullName,
  email,
  avatarUrl,
  avatar,
  size = "md",
}: {
  fullName: string | null;
  email: string | null;
  avatarUrl: string | null;
  avatar?: ResolvedAvatar | null;
  size?: keyof typeof sizes;
}) {
  const resolved: ResolvedAvatar = avatar ?? (safeAvatarUrl(avatarUrl) ? { type: "url", src: safeAvatarUrl(avatarUrl)! } : { type: "initials" });
  const s = sizes[size];
  const className = cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full", s.box);

  if (resolved.type === "image" || resolved.type === "url") {
    return (
      // Signed Storage URLs and admin https URLs; a plain img avoids an open
      // next/image proxy for arbitrary hosts.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={resolved.src} alt="" className={cn(className, "bg-border object-cover")} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
    );
  }

  if (resolved.type === "emoji") {
    return (
      <span aria-hidden="true" className={cn(className, "bg-surface-muted leading-none", s.emoji)}>
        {EMOJI_AVATARS[resolved.id].char}
      </span>
    );
  }

  if (resolved.type === "icon") {
    const Icon = AVATAR_ICON_COMPONENTS[resolved.id];
    return (
      <span aria-hidden="true" className={cn(className, "bg-primary/10 text-primary")}>
        <Icon className={s.icon} strokeWidth={2} />
      </span>
    );
  }

  return (
    <span aria-hidden="true" className={cn(className, "bg-primary/10 font-semibold text-primary")}>
      {initials(fullName, email)}
    </span>
  );
}
