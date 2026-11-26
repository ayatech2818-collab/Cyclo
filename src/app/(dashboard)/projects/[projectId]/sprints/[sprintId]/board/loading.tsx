export default function BoardLoading() {
  return (
    <main className="mx-auto w-full max-w-[96rem] space-y-6 px-4 py-8 sm:px-6" aria-busy="true" aria-label="Loading the sprint board">
      <div className="h-4 w-48 animate-pulse rounded bg-surface-muted" />
      <div className="h-8 w-72 animate-pulse rounded bg-surface-muted" />
      <div className="h-9 w-full animate-pulse rounded bg-surface-muted" />
      <div className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="space-y-2 rounded-xl border border-border bg-surface-muted/60 p-2">
            <div className="h-5 w-24 animate-pulse rounded bg-surface-muted" />
            {Array.from({ length: 3 - (index % 2) }, (_, card) => <div key={card} className="h-24 animate-pulse rounded-lg bg-surface" />)}
          </div>
        ))}
      </div>
    </main>
  );
}
