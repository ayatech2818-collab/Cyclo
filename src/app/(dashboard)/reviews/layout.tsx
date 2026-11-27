import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { requireActiveProfile } from "@/features/auth/server";
import { canUseReviewInbox } from "@/features/reviews/logic";

/**
 * Review Inbox role gate (SA and PM). Runs above the loading boundary, so a
 * developer receives a real 404 before any streaming starts. The queries,
 * the server action and the database enforce the same rule independently.
 */
export default async function ReviewsLayout({ children }: { children: ReactNode }) {
  const { profile } = await requireActiveProfile();
  if (!canUseReviewInbox(profile.role)) notFound();
  return children;
}
