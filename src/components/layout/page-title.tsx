"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

import { useCurrentProject } from "./current-project";
import { pageTitle } from "./navigation";

/** Header breadcrumb: parent (project or section) › current page. */
export function PageTitle() {
  const pathname = usePathname();
  const { project } = useCurrentProject();
  const { title, parent } = pageTitle(pathname, project);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {parent && (
          <li className="hidden min-w-0 items-center gap-1.5 sm:flex">
            <Link href={parent.href} className="truncate text-text-secondary hover:text-text-primary">{parent.label}</Link>
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-text-muted" />
          </li>
        )}
        <li aria-current="page" className="truncate font-semibold text-text-primary">{title}</li>
      </ol>
    </nav>
  );
}
