import Link from "next/link";
import { Search } from "lucide-react";

import { control, primaryButton, secondaryButton } from "@/features/projects/components/styles";
import { PRIORITY_LABELS, PROJECT_PRIORITIES } from "@/features/projects/types";
import { cn } from "@/lib/utils/cn";

import { hasActiveReviewFilters, REVIEW_AGE_LABELS, REVIEW_AGES, REVIEW_SORT_LABELS, REVIEW_SORTS, type ReviewQuery, type ReviewSummary } from "../logic";

const label = "mb-1.5 block text-xs font-medium text-text-secondary";

/**
 * GET form: shareable URLs, works without JavaScript, resets to page 1.
 * Project and assignee choices come from the caller's own pending reviews.
 */
export function ReviewFilters({ query, summary }: { query: ReviewQuery; summary: ReviewSummary }) {
  const assigneeValue = query.assignee.kind === "unassigned" ? "none" : query.assignee.kind === "person" ? query.assignee.id : "";
  const people = summary.assignees.filter((facet) => facet.id !== null);
  const hasUnassigned = summary.assignees.some((facet) => facet.id === null);
  // Keep a selected value visible even when it no longer has pending reviews.
  const projectMissing = query.projectId && !summary.projects.some((facet) => facet.id === query.projectId);
  const personMissing = query.assignee.kind === "person" && !people.some((facet) => facet.id === assigneeValue);

  return (
    <form method="get" action="/reviews" role="search" aria-label="Filter reviews" className="grid grid-cols-2 gap-3 lg:grid-cols-6 lg:items-end">
      <div className="col-span-2">
        <label htmlFor="review-search" className={label}>Search</label>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-secondary" />
          <input id="review-search" name="q" type="search" defaultValue={query.search} maxLength={100} placeholder="Title or key, e.g. CPR-12" autoComplete="off" className={cn(control, "pl-9")} />
        </div>
      </div>
      <div>
        <label htmlFor="review-project" className={label}>Project</label>
        <select id="review-project" name="project" defaultValue={query.projectId ?? ""} className={control}>
          <option value="">All projects</option>
          {projectMissing && <option value={query.projectId!}>Selected project</option>}
          {summary.projects.map((facet) => <option key={facet.id} value={facet.id!}>{facet.projectKey} · {facet.label} ({facet.count})</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="review-assignee" className={label}>Assignee</label>
        <select id="review-assignee" name="assignee" defaultValue={assigneeValue} className={control}>
          <option value="">Anyone</option>
          {hasUnassigned && <option value="none">Unassigned</option>}
          {personMissing && <option value={assigneeValue}>Selected developer</option>}
          {people.map((facet) => <option key={facet.id} value={facet.id!}>{facet.label ?? "Unnamed developer"} ({facet.count})</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="review-priority" className={label}>Priority</label>
        <select id="review-priority" name="priority" defaultValue={query.priority ?? ""} className={control}>
          <option value="">All priorities</option>
          {PROJECT_PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="review-age" className={label}>Review age</label>
        <select id="review-age" name="age" defaultValue={query.minAgeDays ?? ""} className={control}>
          <option value="">Any age</option>
          {REVIEW_AGES.map((age) => <option key={age} value={age}>{REVIEW_AGE_LABELS[age]}</option>)}
        </select>
      </div>
      <div className="col-span-2">
        <label htmlFor="review-sort" className={label}>Sort by</label>
        <select id="review-sort" name="sort" defaultValue={query.sort} className={control}>
          {REVIEW_SORTS.map((sort) => <option key={sort} value={sort}>{REVIEW_SORT_LABELS[sort]}</option>)}
        </select>
      </div>
      <div className="col-span-2 flex gap-2 lg:col-span-4 lg:justify-end">
        {(hasActiveReviewFilters(query) || query.sort !== "oldest") && (
          <Link href="/reviews" className={secondaryButton}>Clear</Link>
        )}
        <button type="submit" className={cn(primaryButton, "flex-1 lg:flex-none")}>Apply</button>
      </div>
    </form>
  );
}
