import { cn } from "@/lib/utils/cn";

import { initials, safeAvatarUrl } from "../format";

const sizes = {
  sm: "size-8 text-xs",
  md: "size-10 text-sm",
  lg: "size-16 text-lg",
} as const;

/** Decorative avatar: the employee's name is always rendered next to it. */
export function EmployeeAvatar({
  fullName,
  email,
  avatarUrl,
  size = "md",
}: {
  fullName: string | null;
  email: string | null;
  avatarUrl: string | null;
  size?: keyof typeof sizes;
}) {
  const src = safeAvatarUrl(avatarUrl);
  const className = cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full", sizes[size]);

  if (src) {
    return (
      // Avatar hosts are configured in Phase 6; a plain img avoids an open
      // next/image proxy for arbitrary https hosts.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" className={cn(className, "bg-border object-cover")} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
    );
  }

  return (
    <span aria-hidden="true" className={cn(className, "bg-primary/10 font-semibold text-primary")}>
      {initials(fullName, email)}
    </span>
  );
}
