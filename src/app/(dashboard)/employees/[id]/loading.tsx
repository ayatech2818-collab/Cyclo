export default function EmployeeDetailLoading() {
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6" aria-busy="true">
      <p className="sr-only" role="status">Loading employee…</p>
      <div className="h-4 w-24 animate-pulse rounded bg-border/70" />
      <div className="flex items-center gap-4">
        <div className="size-16 animate-pulse rounded-full bg-border" />
        <div className="space-y-2">
          <div className="h-7 w-56 animate-pulse rounded bg-border" />
          <div className="h-5 w-40 animate-pulse rounded bg-border/70" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {[0, 1].map((card) => (
          <div key={card} className="h-64 animate-pulse rounded-xl border border-border bg-surface" />
        ))}
      </div>
    </main>
  );
}
