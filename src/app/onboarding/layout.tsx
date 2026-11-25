import { logout } from "@/features/auth/actions";

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return <main className="flex min-h-svh items-center justify-center bg-background px-4 py-10">
    <section className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
      <p className="mb-5 text-sm font-semibold tracking-widest text-primary">CYCLO</p>
      {children}
      <form action={logout} className="mt-6"><button className="text-sm text-text-secondary underline">Sign out</button></form>
    </section>
  </main>;
}
