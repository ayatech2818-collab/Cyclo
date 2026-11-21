import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { isUuid } from "@/features/employees/validation";

/** Rejects malformed ids with a real 404 before the loading boundary streams. */
export default async function EmployeeDetailLayout({ children, params }: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return children;
}
