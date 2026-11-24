import type { ReactNode } from "react";

import { AppHeader } from "@/components/layout/app-header";
import { requireActiveProfile } from "@/features/auth/server";
import { getMyResolvedAvatar } from "@/features/profile/avatars.server";
import { getThemePreference } from "@/lib/theme/server";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const [{ profile }, theme] = await Promise.all([requireActiveProfile(), getThemePreference()]);
  // Decorative: a failed avatar read falls back to initials inside the header.
  const avatar = await getMyResolvedAvatar();
  return (
    <div className="flex min-h-svh flex-col">
      <AppHeader profile={profile} theme={theme} avatar={avatar} />
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
