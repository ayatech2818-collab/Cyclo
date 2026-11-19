import type { ReactNode } from "react";

import { requireActiveProfile } from "@/features/auth/server";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await requireActiveProfile();
  return children;
}
