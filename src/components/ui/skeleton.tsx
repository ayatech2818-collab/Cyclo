import { cn } from "@/lib/utils/cn";

/*
 * Loading placeholders (Phase 8H). One primitive plus page-shaped skeletons,
 * so a loading page has the same outline as the page that replaces it.
 * The pulse is disabled under reduced motion by the global rule.
 */

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-border", className)} />;
}

function Header() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-8 w-56 max-w-full" />
      <Skeleton className="h-4 w-80 max-w-full opacity-70" />
    </div>
  );
}

/** Lists: header, filter row, rows. */
export function ListSkeleton({ label = "Loading…", rows = 6 }: { label?: string; rows?: number }) {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6" aria-busy="true">
      <p className="sr-only" role="status">{label}</p>
      <Header />
      <Skeleton className="h-9 w-full rounded-full opacity-50" />
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-3 p-4">
            <Skeleton className="size-6" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-3/4 opacity-70" />
            </div>
            <Skeleton className="hidden h-6 w-20 rounded-full sm:block" />
          </div>
        ))}
      </div>
    </main>
  );
}

/** Sprint board: header, columns of cards. */
export function BoardSkeleton({ label = "Loading board…" }: { label?: string }) {
  return (
    <main className="mx-auto w-full max-w-[96rem] space-y-6 px-4 py-8 sm:px-6" aria-busy="true">
      <p className="sr-only" role="status">{label}</p>
      <Header />
      <div className="grid gap-3 overflow-hidden sm:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, column) => (
          <div key={column} className={cn("space-y-2 rounded-xl border border-border bg-surface-muted/60 p-2", column > 0 && "hidden sm:block", column > 2 && "sm:hidden xl:block")}>
            <Skeleton className="h-5 w-24" />
            {Array.from({ length: 3 - (column % 2) }, (_, card) => <Skeleton key={card} className="h-24 w-full rounded-lg opacity-60" />)}
          </div>
        ))}
      </div>
    </main>
  );
}
