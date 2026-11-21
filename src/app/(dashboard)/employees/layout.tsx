import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { requireActiveProfile } from "@/features/auth/server";
import { canViewDirectory } from "@/features/employees/validation";

/**
 * Directory role gate. Runs above the loading boundary, so an unauthorized
 * role receives a real 404 status before any streaming starts. Pages and RPCs
 * still enforce the same rule independently.
 */
export default async function EmployeesLayout({ children }: { children: ReactNode }) {
  const { profile } = await requireActiveProfile();
  if (!canViewDirectory(profile.role)) notFound();
  return children;
}
