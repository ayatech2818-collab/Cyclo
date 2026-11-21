"use client";

import { AlertTriangle } from "lucide-react";

import { StatePanel, secondaryButton } from "@/features/employees/components/state-panel";

/** Fallback for unexpected failures. Never shows the error message (it may contain internals). */
export default function EmployeesError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <StatePanel
        tone="danger"
        icon={AlertTriangle}
        title="Something went wrong"
        description="Employee information could not be displayed. Please try again."
        action={<button type="button" onClick={reset} className={secondaryButton}>Try again</button>}
      />
    </main>
  );
}
