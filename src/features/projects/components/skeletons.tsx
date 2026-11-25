const bar = "animate-pulse rounded bg-border";

export function FormSkeleton({ label }: { label: string }) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6" aria-busy="true">
      <p className="sr-only" role="status">{label}</p>
      <div className={`h-4 w-20 ${bar}`} />
      <div className="space-y-2">
        <div className={`h-7 w-44 ${bar}`} />
        <div className={`h-4 w-72 max-w-full ${bar} bg-border/70`} />
      </div>
      <div className="space-y-5 rounded-xl border border-border bg-surface p-6">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-2">
            <div className={`h-4 w-28 ${bar}`} />
            <div className={`h-10 w-full ${bar} bg-border/70`} />
          </div>
        ))}
      </div>
    </main>
  );
}

export function DetailSkeleton() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6" aria-busy="true">
      <p className="sr-only" role="status">Loading project…</p>
      <div className={`h-4 w-20 ${bar}`} />
      <div className="space-y-3">
        <div className={`h-5 w-16 ${bar}`} />
        <div className={`h-8 w-72 max-w-full ${bar}`} />
        <div className="flex gap-2">
          <div className={`h-5 w-20 rounded-full ${bar} bg-border/70`} />
          <div className={`h-5 w-20 rounded-full ${bar} bg-border/70`} />
        </div>
      </div>
      <div className={`h-10 w-full ${bar} bg-border/50`} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className={`h-56 rounded-xl ${bar} bg-border/50`} />
        <div className={`h-56 rounded-xl ${bar} bg-border/50`} />
      </div>
    </main>
  );
}
