import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, SearchX } from "lucide-react";

import { PagePagination } from "@/components/shared/page-pagination";
import { requireActiveProfile } from "@/features/auth/server";
import { EmptyState } from "@/components/ui/empty-state";
import { secondaryButton } from "@/components/ui/styles";
import { PROJECT_ERROR_MESSAGES } from "@/features/projects/errors";
import { loadProjectForPage } from "@/features/projects/page-errors.server";
import { ReviewFilters } from "@/features/reviews/components/review-filters";
import { ReviewInbox } from "@/features/reviews/components/review-inbox";
import { hasActiveReviewFilters, parseReviewQuery, REVIEW_PAGE_SIZE, reviewsHref } from "@/features/reviews/logic";
import { getReviewSummary, listReviewQueue } from "@/features/reviews/queries.server";

export const metadata: Metadata = { title: "Reviews | CYCLO" };

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { profile } = await requireActiveProfile();
  const query = parseReviewQuery(await searchParams);

  // Summary and queue in parallel; each fails independently (forbidden → 404).
  const [summary, list] = await Promise.all([
    loadProjectForPage(() => getReviewSummary()),
    loadProjectForPage(() => listReviewQueue(query)),
  ]);

  const heading = (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Review inbox</h1>
      <p className="text-sm text-text-secondary">
        {profile.role === "SUPER_ADMIN" ? "Work awaiting review across all projects." : "Work awaiting review in the projects you manage."} Oldest first, so nothing waits too long.
      </p>
    </header>
  );

  if (summary.error) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        {heading}
        <EmptyState tone="danger" icon={AlertTriangle} title="Couldn’t load reviews" description={PROJECT_ERROR_MESSAGES[summary.error]}
          action={<Link href={reviewsHref(query)} className={secondaryButton}>Try again</Link>} />
      </main>
    );
  }

  let body;
  if (list.error) {
    body = (
      <EmptyState tone="danger" icon={AlertTriangle} title="Couldn’t load the review queue" description={PROJECT_ERROR_MESSAGES[list.error]}
        action={<Link href={reviewsHref(query)} className={secondaryButton}>Try again</Link>} />
    );
  } else if (list.data.items.length === 0 && list.data.total > 0) {
    body = (
      <EmptyState icon={SearchX} title="This page is out of range" description={`There ${list.data.pageCount === 1 ? "is 1 page" : `are ${list.data.pageCount} pages`} of reviews.`}
        action={<Link href={reviewsHref(query, { page: 1 })} className={secondaryButton}>Go to first page</Link>} />
    );
  } else {
    body = (
      <div className="space-y-4">
        <ReviewInbox items={list.data.items} summary={summary.data} now={list.data.asOf} filtered={hasActiveReviewFilters(query)} page={query.page} />
        {list.data.total > 0 && (
          <PagePagination page={query.page} pageSize={REVIEW_PAGE_SIZE} pageCount={list.data.pageCount} total={list.data.total}
            noun={{ one: "review", many: "reviews" }} hrefFor={(page) => reviewsHref(query, { page })} />
        )}
      </div>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      {heading}
      <ReviewFilters query={query} summary={summary.data} />
      {body}
    </main>
  );
}
