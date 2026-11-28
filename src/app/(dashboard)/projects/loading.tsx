export default function ProjectsLoading() {
  return (
    <main className="mx-auto w-full max-w-[88rem] space-y-6 px-4 py-6 sm:px-6 lg:py-8" aria-busy="true">
      <p className="sr-only" role="status">Loading projects…</p>
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="h-8 w-40 animate-pulse rounded bg-border" />
          <div className="h-4 w-56 max-w-full animate-pulse rounded bg-border/70" />
        </div>
        <div className="h-9 w-32 animate-pulse rounded-full bg-border/70" />
      </div>
      <div className="space-y-4 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex justify-between">
          <div className="h-10 w-44 animate-pulse rounded-full bg-border/70" />
          <div className="h-10 w-28 animate-pulse rounded-full bg-border/70" />
        </div>
        <div className="flex gap-2 overflow-hidden">
          {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-8 w-24 shrink-0 animate-pulse rounded-full bg-border/60" />)}
        </div>
        <div className="h-9 animate-pulse rounded-md border-t border-border bg-border/50" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="space-y-3 rounded-xl border border-border bg-surface p-5">
            <div className="flex gap-3">
              <div className="size-11 animate-pulse rounded-xl bg-border/70" />
              <div className="flex-1 space-y-2">
                <div className="h-5 w-2/3 animate-pulse rounded bg-border" />
                <div className="h-3 w-12 animate-pulse rounded bg-border/70" />
              </div>
            </div>
            <div className="h-4 w-full animate-pulse rounded bg-border/70" />
            <div className="h-4 w-4/5 animate-pulse rounded bg-border/70" />
            <div className="flex gap-2">
              <div className="h-5 w-20 animate-pulse rounded-full bg-border/70" />
              <div className="h-5 w-16 animate-pulse rounded-full bg-border/70" />
            </div>
            <div className="h-1.5 w-full animate-pulse rounded-full bg-border/60" />
            <div className="flex items-center gap-2 border-t border-border pt-4">
              <div className="size-8 animate-pulse rounded-full bg-border/70" />
              <div className="h-3 w-1/3 animate-pulse rounded bg-border/70" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
