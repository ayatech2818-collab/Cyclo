import Link from "next/link";
import { FileQuestion } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { secondaryButton } from "@/components/ui/styles";

/** Shown for missing pages and for pages the current role may not access (not disclosed). */
export default function DashboardNotFound() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <EmptyState
        icon={FileQuestion}
        title="Page not found"
        description="The page you are looking for does not exist or is not available to your account."
        action={<Link href="/dashboard" className={secondaryButton}>Go to dashboard</Link>}
      />
    </main>
  );
}
