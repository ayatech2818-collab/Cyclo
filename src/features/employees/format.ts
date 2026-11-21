/** Display helpers shared by employee components. Pure and framework-free. */

export function displayName(fullName: string | null, email: string | null): string {
  return fullName?.trim() || email || "Unnamed employee";
}

export function initials(fullName: string | null, email: string | null): string {
  const source = fullName?.trim() || email?.split("@")[0] || "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "").slice(0, 2);
  return letters.toUpperCase() || "?";
}

/** Only https URLs are rendered (matches the profiles_avatar_url_https constraint). */
export function safeAvatarUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** Server-rendered timestamps use a fixed locale and UTC so output is deterministic. */
export function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : `${dateTimeFormat.format(date)} UTC`;
}

export type PaginationItem = number | "gap";

/** Page numbers to render: first, last, and the current page ± 1, with gaps. */
export function paginationItems(page: number, pageCount: number): PaginationItem[] {
  if (pageCount <= 1) return [1];
  const pages = new Set([1, pageCount, page - 1, page, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const items: PaginationItem[] = [];
  for (const p of sorted) {
    const previous = items[items.length - 1];
    if (typeof previous === "number" && p - previous === 2) items.push(previous + 1);
    else if (typeof previous === "number" && p - previous > 2) items.push("gap");
    items.push(p);
  }
  return items;
}
