import type { ReactNode } from "react";

import { AppHeader } from "@/components/layout/app-header";
import { requireActiveProfile } from "@/features/auth/server";
import { getThemePreference } from "@/lib/theme/server";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const [{ profile }, theme] = await Promise.all([requireActiveProfile(), getThemePreference()]);
  return (
    <div className="flex min-h-svh flex-col">
      <AppHeader profile={profile} theme={theme} />
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
