/** Display helpers for projects. Pure and framework-free. */

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Formats a YYYY-MM-DD date or ISO timestamp deterministically (UTC). */
export function formatProjectDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

/** "1 Dec 2026 → 1 Mar 2027", "Starts 1 Dec 2026", "Due 1 Mar 2027" or null. */
export function formatDateRange(start: string | null, target: string | null): string | null {
  const from = formatProjectDate(start);
  const to = formatProjectDate(target);
  if (from && to) return `${from} → ${to}`;
  if (from) return `Starts ${from}`;
  if (to) return `Due ${to}`;
  return null;
}

export function managerLabel(name: string | null, fallback = "Unassigned"): string {
  return name?.trim() || fallback;
}
