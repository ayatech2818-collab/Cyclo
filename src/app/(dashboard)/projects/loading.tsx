export default function ProjectsLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6" aria-busy="true">
      <p className="sr-only" role="status">Loading projects…</p>
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="h-7 w-36 animate-pulse rounded bg-border" />
          <div className="h-4 w-56 max-w-full animate-pulse rounded bg-border/70" />
        </div>
        <div className="h-10 w-32 animate-pulse rounded-md bg-border/70" />
      </div>
      <div className="h-11 w-48 animate-pulse rounded-lg bg-border/70" />
      <div className="h-10 animate-pulse rounded-md bg-border/70" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="space-y-3 rounded-xl border border-border bg-surface p-5">
            <div className="flex justify-between">
              <div className="h-5 w-14 animate-pulse rounded bg-border" />
              <div className="h-5 w-16 animate-pulse rounded-full bg-border/70" />
            </div>
            <div className="h-5 w-2/3 animate-pulse rounded bg-border" />
            <div className="h-4 w-full animate-pulse rounded bg-border/70" />
            <div className="h-4 w-4/5 animate-pulse rounded bg-border/70" />
            <div className="h-5 w-20 animate-pulse rounded-full bg-border/70" />
            <div className="space-y-2 border-t border-border pt-4">
              <div className="h-3 w-1/2 animate-pulse rounded bg-border/70" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-border/70" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
