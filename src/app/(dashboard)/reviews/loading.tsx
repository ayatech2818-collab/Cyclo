const bar = "animate-pulse rounded bg-border";

export default function ReviewsLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6" aria-busy="true">
      <p className="sr-only" role="status">Loading reviews…</p>
      <div className="space-y-2">
        <div className={`h-8 w-48 ${bar}`} />
        <div className={`h-4 w-80 max-w-full ${bar} bg-border/70`} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => <div key={index} className={`h-[4.5rem] rounded-xl ${bar} bg-border/50`} />)}
      </div>
      <div className={`h-24 w-full rounded-xl ${bar} bg-border/40 lg:h-16`} />
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 p-4">
            <div className={`size-6 ${bar}`} />
            <div className="flex-1 space-y-2">
              <div className={`h-3 w-24 ${bar}`} />
              <div className={`h-4 w-3/4 ${bar} bg-border/70`} />
            </div>
            <div className={`hidden h-8 w-48 sm:block ${bar} bg-border/60`} />
          </div>
        ))}
      </div>
    </main>
  );
}
