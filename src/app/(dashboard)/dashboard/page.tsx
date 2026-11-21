import type { Metadata } from "next";

import { logout } from "@/features/auth/actions";
import { requireActiveProfile } from "@/features/auth/server";

export const metadata: Metadata = { title: "Dashboard | CYCLO" };

export default async function DashboardPage() {
  const { profile, user } = await requireActiveProfile();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-6 py-12">
      <section aria-labelledby="dashboard-title" className="w-full rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-10">
        <p className="text-sm font-semibold tracking-widest text-primary">CYCLO</p>
        <h1 id="dashboard-title" className="mt-4 text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-2 text-sm text-text-secondary">Plan. Build. Review. Deliver.</p>
        <dl className="my-8 space-y-5">
          {[
            ["Name", profile.full_name?.trim() || "Name not set"],
            ["Email", profile.email || user.email || "Email not available"],
            ["Role", profile.role],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm text-text-secondary">{label}</dt>
              <dd className="mt-1 break-words font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <form action={logout}>
          <button type="submit" className="rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-surface hover:bg-primary-hover">Log out</button>
        </form>
      </section>
    </main>
  );
}
