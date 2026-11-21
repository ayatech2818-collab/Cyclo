import type { ReactNode } from "react";

import { AppHeader } from "@/components/layout/app-header";
import { requireActiveProfile } from "@/features/auth/server";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { profile } = await requireActiveProfile();
  return (
    <div className="flex min-h-svh flex-col">
      <AppHeader profile={profile} />
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
