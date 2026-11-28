import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils/cn";

import { paginationItems } from "../format";
import type { EmployeeDirectoryQuery } from "../types";
import { directoryHref } from "../validation";

const item = "inline-flex h-9 min-w-9 items-center justify-center rounded-md px-3 text-sm font-medium";

export function Pagination({ query, pageCount, total }: { query: EmployeeDirectoryQuery; pageCount: number; total: number }) {
  const { page, pageSize } = query;
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
      <p className="text-sm text-text-secondary" aria-live="polite">
        Showing <span className="font-medium text-text-primary">{first}–{last}</span> of{" "}
        <span className="font-medium text-text-primary">{total}</span>
      </p>

      {pageCount > 1 && (
        <nav aria-label="Pagination" className="flex items-center gap-1">
          {page > 1 ? (
            <Link href={directoryHref(query, { page: page - 1 })} className={cn(item, "text-text-primary hover:bg-surface")} aria-label="Previous page">
              <ChevronLeft aria-hidden="true" className="size-4" />
            </Link>
          ) : (
            <span className={cn(item, "text-text-secondary/50")} aria-hidden="true"><ChevronLeft className="size-4" /></span>
          )}

          {paginationItems(page, pageCount).map((entry, index) =>
            entry === "gap" ? (
              <span key={`gap-${index}`} className={cn(item, "hidden text-text-secondary sm:inline-flex")} aria-hidden="true">…</span>
            ) : (
              <Link
                key={entry}
                href={directoryHref(query, { page: entry })}
                aria-label={`Page ${entry}`}
                aria-current={entry === page ? "page" : undefined}
                className={cn(
                  item,
                  entry === page ? "bg-action text-primary-foreground" : "hidden text-text-primary hover:bg-surface sm:inline-flex",
                )}
              >
                {entry}
              </Link>
            ),
          )}

          {page < pageCount ? (
            <Link href={directoryHref(query, { page: page + 1 })} className={cn(item, "text-text-primary hover:bg-surface")} aria-label="Next page">
              <ChevronRight aria-hidden="true" className="size-4" />
            </Link>
          ) : (
            <span className={cn(item, "text-text-secondary/50")} aria-hidden="true"><ChevronRight className="size-4" /></span>
          )}
        </nav>
      )}
    </div>
  );
}
