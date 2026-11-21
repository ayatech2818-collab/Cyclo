import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { displayName } from "../format";
import type { EmployeeDirectoryItem } from "../types";
import { EmployeeAvatar } from "./employee-avatar";
import { EmployeeStatusBadge, RoleBadge } from "./employee-badges";

function Code({ value }: { value: string | null }) {
  return value ? <span className="font-mono text-xs">{value}</span> : <span className="text-text-secondary">—</span>;
}

function YouTag({ show }: { show: boolean }) {
  return show ? <span className="ml-2 rounded bg-background px-1.5 py-0.5 text-[11px] font-medium text-text-secondary">You</span> : null;
}

/**
 * Directory listing. Only directory DTO fields are available here, so
 * administrative data cannot be rendered by mistake.
 */
export function EmployeeTable({ employees, currentUserId }: { employees: EmployeeDirectoryItem[]; currentUserId: string }) {
  return (
    <>
      {/* Tablet and desktop */}
      <div className="hidden overflow-x-auto rounded-xl border border-border bg-surface shadow-sm md:block">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Employees</caption>
          <thead className="border-b border-border bg-background/60 text-xs font-medium text-text-secondary">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Employee</th>
              <th scope="col" className="px-4 py-3 font-medium">Employee code</th>
              <th scope="col" className="px-4 py-3 font-medium">Role</th>
              <th scope="col" className="px-4 py-3 font-medium">Status</th>
              <th scope="col" className="px-4 py-3 text-right font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {employees.map((employee) => {
              const name = displayName(employee.fullName, employee.email);
              return (
                <tr key={employee.id} className="hover:bg-background/60">
                  <td className="px-4 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <EmployeeAvatar fullName={employee.fullName} email={employee.email} avatarUrl={employee.avatarUrl} />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-text-primary">
                          {name}
                          <YouTag show={employee.id === currentUserId} />
                        </p>
                        <p className="truncate text-xs text-text-secondary">{employee.email ?? "No email"}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3"><Code value={employee.employeeCode} /></td>
                  <td className="px-4 py-3"><RoleBadge role={employee.role} /></td>
                  <td className="px-4 py-3"><EmployeeStatusBadge isActive={employee.isActive} /></td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/employees/${employee.id}`}
                      aria-label={`View details for ${name}`}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-primary/10"
                    >
                      View
                      <ChevronRight aria-hidden="true" className="size-4" />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile */}
      <ul className="space-y-3 md:hidden" aria-label="Employees">
        {employees.map((employee) => {
          const name = displayName(employee.fullName, employee.email);
          return (
            <li key={employee.id}>
              <Link
                href={`/employees/${employee.id}`}
                aria-label={`View details for ${name}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm hover:border-primary/40"
              >
                <EmployeeAvatar fullName={employee.fullName} email={employee.email} avatarUrl={employee.avatarUrl} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {name}
                    <YouTag show={employee.id === currentUserId} />
                  </p>
                  <p className="truncate text-xs text-text-secondary">{employee.email ?? "No email"}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <RoleBadge role={employee.role} />
                    <EmployeeStatusBadge isActive={employee.isActive} />
                    {employee.employeeCode && <Code value={employee.employeeCode} />}
                  </div>
                </div>
                <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
