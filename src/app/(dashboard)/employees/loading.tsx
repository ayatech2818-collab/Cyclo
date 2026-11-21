export default function EmployeesLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6" aria-busy="true">
      <p className="sr-only" role="status">Loading employees…</p>
      <div className="space-y-2">
        <div className="h-7 w-40 animate-pulse rounded bg-border" />
        <div className="h-4 w-72 max-w-full animate-pulse rounded bg-border/70" />
      </div>
      <div className="h-10 animate-pulse rounded-md bg-border/70" />
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
            <div className="size-10 animate-pulse rounded-full bg-border" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-1/3 animate-pulse rounded bg-border" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-border/70" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
