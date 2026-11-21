import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";

import { getRequestAccess, requireActiveProfile } from "@/features/auth/server";
import { EmployeeAdminFields, EmployeeDirectoryFields, EmployeeHeader } from "@/features/employees/components/employee-details";
import { StatePanel, secondaryButton } from "@/features/employees/components/state-panel";
import { EMPLOYEE_ERROR_MESSAGES } from "@/features/employees/errors";
import { loadForPage } from "@/features/employees/page-errors.server";
import { adminGetEmployee, getEmployee } from "@/features/employees/queries.server";
import { canViewDirectory, isUuid } from "@/features/employees/validation";

// Employee names are never placed in tab titles or browser history. Unauthorized
// roles get the same title as any missing page.
export async function generateMetadata(): Promise<Metadata> {
  const access = await getRequestAccess();
  const allowed = access.status === "authorized" && canViewDirectory(access.profile.role);
  return { title: allowed ? "Employee | CYCLO" : "Page not found | CYCLO" };
}

export default async function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { profile } = await requireActiveProfile();
  if (!canViewDirectory(profile.role)) notFound();

  const { id } = await params;
  if (!isUuid(id)) notFound();

  const isSuperAdmin = profile.role === "SUPER_ADMIN";
  // Each role gets its own RPC and DTO: Project Managers never receive admin fields.
  const result = isSuperAdmin
    ? await loadForPage(async () => ({ admin: await adminGetEmployee(id), directory: null }))
    : await loadForPage(async () => ({ admin: null, directory: await getEmployee(id) }));

  const back = (
    <Link href="/employees" className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary">
      <ArrowLeft aria-hidden="true" className="size-4" />
      Employees
    </Link>
  );

  if (result.error) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
        {back}
        <StatePanel
          tone="danger"
          icon={AlertTriangle}
          title="Couldn’t load this employee"
          description={EMPLOYEE_ERROR_MESSAGES[result.error]}
          action={<Link href={`/employees/${id}`} className={secondaryButton}>Try again</Link>}
        />
      </main>
    );
  }

  const employee = result.data.admin ?? result.data.directory;
  if (!employee) notFound();

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      {back}
      <EmployeeHeader employee={employee} isSelf={employee.id === profile.id} />
      <div className="grid gap-6 lg:grid-cols-2">
        <EmployeeDirectoryFields employee={employee} />
        {result.data.admin && <EmployeeAdminFields employee={result.data.admin} />}
      </div>
    </main>
  );
}
