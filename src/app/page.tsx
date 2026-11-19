import { Orbit } from "lucide-react";

export default function HomePage() {
  return (
    <main className="flex min-h-svh items-center justify-center px-6 py-12">
      <section aria-labelledby="cyclo-title" className="w-full max-w-xl rounded-2xl border border-border bg-surface px-6 py-14 text-center shadow-sm sm:px-12 sm:py-20">
        <div className="mx-auto mb-8 flex size-14 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Orbit aria-hidden="true" className="size-8" strokeWidth={1.75} />
        </div>
        <p className="mb-3 text-xs font-medium tracking-[0.18em] text-text-secondary uppercase">AyaTech</p>
        <h1 id="cyclo-title" className="text-4xl font-semibold tracking-tight sm:text-5xl">CYCLO</h1>
        <p className="mt-4 text-base text-text-secondary sm:text-lg">Engineering Delivery Management</p>
        <div aria-hidden="true" className="mx-auto my-8 h-px w-12 bg-border" />
        <p className="text-sm font-medium text-text-primary sm:text-base">Plan. Build. Review. Deliver.</p>
      </section>
    </main>
  );
}
