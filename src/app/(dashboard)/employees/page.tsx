import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, SearchX, Users } from "lucide-react";

import { getRequestAccess, requireActiveProfile } from "@/features/auth/server";
import { EmployeeFilters } from "@/features/employees/components/employee-filters";
import { EmployeeTable } from "@/features/employees/components/employee-table";
import { Pagination } from "@/features/employees/components/pagination";
import { StatePanel, secondaryButton } from "@/features/employees/components/state-panel";
import { EMPLOYEE_ERROR_MESSAGES } from "@/features/employees/errors";
import { loadForPage } from "@/features/employees/page-errors.server";
import { listEmployees } from "@/features/employees/queries.server";
import { canViewDirectory, directoryHref, hasActiveFilters, parseDirectoryQuery } from "@/features/employees/validation";

// Role-aware title: unauthorized roles get the same title as any missing page.
export async function generateMetadata(): Promise<Metadata> {
  const access = await getRequestAccess();
  const allowed = access.status === "authorized" && canViewDirectory(access.profile.role);
  return { title: allowed ? "Employees | CYCLO" : "Page not found | CYCLO" };
}

export default async function EmployeesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { profile } = await requireActiveProfile();
  // Developers do not learn that the directory exists. The RPC enforces this too.
  if (!canViewDirectory(profile.role)) notFound();

  const query = parseDirectoryQuery(await searchParams);
  const result = await loadForPage(() => listEmployees(query));

  let body;
  if (result.error) {
    body = (
      <StatePanel
        tone="danger"
        icon={AlertTriangle}
        title="Couldn’t load employees"
        description={EMPLOYEE_ERROR_MESSAGES[result.error]}
        action={<Link href={directoryHref(query)} className={secondaryButton}>Try again</Link>}
      />
    );
  } else if (result.data.items.length > 0) {
    body = (
      <div className="space-y-4">
        <EmployeeTable employees={result.data.items} currentUserId={profile.id} />
        <Pagination query={query} pageCount={result.data.pageCount} total={result.data.total} />
      </div>
    );
  } else if (result.data.total > 0) {
    body = (
      <StatePanel
        icon={SearchX}
        title="This page is out of range"
        description={`There are ${result.data.pageCount} page${result.data.pageCount === 1 ? "" : "s"} of results.`}
        action={<Link href={directoryHref(query, { page: 1 })} className={secondaryButton}>Go to first page</Link>}
      />
    );
  } else if (hasActiveFilters(query)) {
    body = (
      <StatePanel
        icon={SearchX}
        title="No matching employees"
        description="Try a different name, email or employee code, or clear the filters."
        action={<Link href="/employees" className={secondaryButton}>Clear filters</Link>}
      />
    );
  } else {
    body = <StatePanel icon={Users} title="No employees yet" description="Employees appear here once they have been added to CYCLO." />;
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {profile.role === "SUPER_ADMIN"
            ? "Search the employee directory and open an employee to view administrative details."
            : "Search the employee directory."}
        </p>
      </div>
      <EmployeeFilters query={query} />
      {body}
    </main>
  );
}
