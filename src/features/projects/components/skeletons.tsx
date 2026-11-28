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

/** Project pages: the overview's summary card, or the compact section title. */
export function DetailSkeleton({ variant = "section" }: { variant?: "overview" | "section" }) {
  if (variant === "section") {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6" aria-busy="true">
        <p className="sr-only" role="status">Loading project…</p>
        <div className="flex items-center gap-3">
          <div className={`size-11 rounded-xl ${bar} bg-border/70`} />
          <div className="space-y-2">
            <div className={`h-3 w-16 ${bar} bg-border/70`} />
            <div className={`h-6 w-56 max-w-full ${bar}`} />
          </div>
        </div>
        <div className={`h-56 rounded-xl ${bar} bg-border/50`} />
      </main>
    );
  }
  return (
    <main className="mx-auto w-full max-w-[88rem] space-y-6 px-4 py-6 sm:px-6 lg:py-8" aria-busy="true">
      <p className="sr-only" role="status">Loading project…</p>
      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        <div className="h-1.5 bg-border/60" />
        <div className="flex gap-4 p-5 sm:p-6">
          <div className={`hidden size-14 rounded-2xl sm:block ${bar} bg-border/70`} />
          <div className="flex-1 space-y-3">
            <div className={`h-3 w-12 ${bar} bg-border/70`} />
            <div className={`h-8 w-72 max-w-full ${bar}`} />
            <div className="flex gap-2">
              <div className={`h-5 w-20 rounded-full ${bar} bg-border/70`} />
              <div className={`h-5 w-20 rounded-full ${bar} bg-border/70`} />
            </div>
            <div className={`h-4 w-full max-w-xl ${bar} bg-border/50`} />
          </div>
        </div>
        <div className={`h-16 border-t border-border bg-surface-muted/40`} />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className={`h-[74px] rounded-xl ${bar} bg-border/50`} />)}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className={`h-72 rounded-xl ${bar} bg-border/50`} />
        <div className={`h-72 rounded-xl ${bar} bg-border/50`} />
      </div>
    </main>
  );
}
