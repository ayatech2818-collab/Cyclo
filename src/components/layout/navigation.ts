// Relative imports keep this module loadable by the plain-Node unit tests.
import type { AppRole } from "../../features/auth/access";
import { canViewDirectory } from "../../features/employees/validation";
import { isUuid } from "../../features/projects/validation";
import { canUseReviewInbox } from "../../features/reviews/logic";

/*
 * Application navigation (Phase 8H Part 1). Pure: which entries a role sees,
 * which entry a path activates, and the header title for a path. Every entry
 * is an existing route; hiding one never replaces the page's own server-side
 * permission check.
 */

export type NavIcon =
  | "dashboard" | "projects" | "reviews" | "notifications" | "employees" | "settings"
  | "overview" | "work" | "backlog" | "sprints" | "team" | "activity";

export type NavItem = { id: string; label: string; href: string; icon: NavIcon };

export function workspaceNav(role: AppRole): NavItem[] {
  const items: NavItem[] = [
    { id: "dashboard", label: "Dashboard", href: "/dashboard", icon: "dashboard" },
    { id: "projects", label: "Projects", href: "/projects", icon: "projects" },
  ];
  if (canUseReviewInbox(role)) items.push({ id: "reviews", label: "Reviews", href: "/reviews", icon: "reviews" });
  items.push({ id: "notifications", label: "Notifications", href: "/notifications", icon: "notifications" });
  return items;
}

export function managementNav(role: AppRole): NavItem[] {
  const items: NavItem[] = [];
  if (canViewDirectory(role)) items.push({ id: "employees", label: "Employees", href: "/employees", icon: "employees" });
  // Settings groups the existing personal settings pages (profile and notification preferences).
  items.push({ id: "settings", label: "Settings", href: "/profile", icon: "settings" });
  return items;
}

export const PROJECT_SECTIONS = [
  { id: "overview", label: "Overview", path: "", icon: "overview" },
  { id: "work", label: "Work", path: "/work", icon: "work" },
  { id: "backlog", label: "Backlog", path: "/backlog", icon: "backlog" },
  { id: "sprints", label: "Sprints", path: "/sprints", icon: "sprints" },
  { id: "team", label: "Team", path: "/team", icon: "team" },
  { id: "activity", label: "Activity", path: "/activity", icon: "activity" },
] as const satisfies readonly { id: string; label: string; path: string; icon: NavIcon }[];

export type ProjectSectionId = (typeof PROJECT_SECTIONS)[number]["id"];

export function projectNav(projectId: string): NavItem[] {
  return PROJECT_SECTIONS.map((section) => ({ id: `project-${section.id}`, label: section.label, href: `/projects/${projectId}${section.path}`, icon: section.icon }));
}

/** The project id in a /projects/[id]/… path (only real ids; "new" is not a project). */
export function projectIdFromPath(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname);
  return match && isUuid(match[1]) ? match[1].toLowerCase() : null;
}

/** The project section a path belongs to (the edit page belongs to Overview). */
export function projectSectionOf(pathname: string): ProjectSectionId | null {
  if (!projectIdFromPath(pathname)) return null;
  const rest = pathname.replace(/^\/projects\/[^/]+/, "");
  const first = rest.split("/")[1] ?? "";
  const section = PROJECT_SECTIONS.find((entry) => entry.path === `/${first}`);
  return section ? section.id : "overview";
}

/** Which navigation entry a path activates (exactly one, or none). */
export function activeNavId(pathname: string): string | null {
  const section = projectSectionOf(pathname);
  if (section) return `project-${section}`;
  if (pathname === "/dashboard") return "dashboard";
  if (pathname === "/projects" || pathname.startsWith("/projects/")) return "projects";
  if (pathname === "/reviews" || pathname.startsWith("/reviews/")) return "reviews";
  if (pathname === "/notifications/settings" || pathname === "/profile") return "settings";
  if (pathname === "/notifications" || pathname.startsWith("/notifications/")) return "notifications";
  if (pathname === "/employees" || pathname.startsWith("/employees/")) return "employees";
  return null;
}

export type PageTitle = { title: string; parent: { label: string; href: string } | null };

const TOP_LEVEL: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/projects": "Projects",
  "/projects/new": "New project",
  "/reviews": "Reviews",
  "/notifications": "Notifications",
  "/notifications/settings": "Notification settings",
  "/employees": "Employees",
  "/employees/invitations": "Invitations",
  "/profile": "Profile",
};

/** Header title (and parent crumb) for a path; the project name comes from the current project. */
export function pageTitle(pathname: string, project: { id: string; name: string } | null): PageTitle {
  if (TOP_LEVEL[pathname]) {
    const parent = pathname === "/notifications/settings" || pathname === "/profile" ? { label: "Settings", href: "/profile" }
      : pathname === "/employees/invitations" ? { label: "Employees", href: "/employees" }
      : pathname === "/projects/new" ? { label: "Projects", href: "/projects" } : null;
    return { title: TOP_LEVEL[pathname], parent };
  }
  const projectId = projectIdFromPath(pathname);
  if (projectId) {
    const rest = pathname.replace(/^\/projects\/[^/]+/, "");
    const parts = rest.split("/").filter(Boolean);
    const section = PROJECT_SECTIONS.find((entry) => entry.path === `/${parts[0] ?? ""}`) ?? PROJECT_SECTIONS[0];
    const title = parts[0] === "edit" ? "Edit project"
      : parts[0] === "work" && parts[1] === "new" ? "New work item"
      : parts[0] === "work" && parts[1] ? "Work item"
      : parts[0] === "sprints" && parts[2] === "board" ? "Sprint board"
      : parts[0] === "sprints" && parts[1] ? "Sprint"
      : section.label;
    const name = project && project.id === projectId ? project.name : "Project";
    return { title, parent: { label: name, href: `/projects/${projectId}` } };
  }
  if (pathname.startsWith("/employees/")) return { title: "Employee", parent: { label: "Employees", href: "/employees" } };
  return { title: "CYCLO", parent: null };
}

/**
 * Switching project keeps you in the same section (Backlog → Backlog); deeper
 * pages (a work item, a sprint) fall back to their section's list.
 */
export function switchTarget(pathname: string, projectId: string): string {
  const section = PROJECT_SECTIONS.find((entry) => entry.id === projectSectionOf(pathname)) ?? PROJECT_SECTIONS[0];
  return `/projects/${projectId}${section.path}`;
}

// ---------------------------------------------------------------------------
// Last selected project (a lightweight cookie; no database state)
// ---------------------------------------------------------------------------

export const LAST_PROJECT_COOKIE = "cyclo-project";

/** Stored as "<userId>.<projectId>" so another person on the same browser never inherits it. */
export function lastProjectValue(userId: string, projectId: string): string {
  return `${userId}.${projectId}`;
}

export function parseLastProject(value: string | undefined | null, userId: string): string | null {
  if (!value) return null;
  const [owner, projectId] = value.split(".");
  return owner === userId && isUuid(projectId) ? projectId.toLowerCase() : null;
}
