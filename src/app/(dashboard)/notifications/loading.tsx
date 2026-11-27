const bar = "animate-pulse rounded bg-border";

export default function NotificationsLoading() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6" aria-busy="true">
      <p className="sr-only" role="status">Loading notifications…</p>
      <div className="space-y-2">
        <div className={`h-8 w-48 ${bar}`} />
        <div className={`h-4 w-72 max-w-full ${bar} bg-border/70`} />
      </div>
      <div className={`h-10 w-56 rounded-lg ${bar} bg-border/50`} />
      <div className="space-y-1 rounded-xl border border-border bg-surface p-1.5">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex gap-3 p-3">
            <div className={`size-10 rounded-full ${bar}`} />
            <div className="flex-1 space-y-2">
              <div className={`h-4 w-3/4 ${bar}`} />
              <div className={`h-3 w-1/2 ${bar} bg-border/70`} />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
