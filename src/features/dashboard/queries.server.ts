import "server-only";

import type { AppRole } from "@/features/auth/access";
import { requireActiveProfile } from "@/features/auth/server";
import { listEmployees } from "@/features/employees/queries.server";
import { listNotifications, getUnreadCount } from "@/features/notifications/queries.server";
import type { Notification } from "@/features/notifications/logic";
import type { ActivityEntry } from "@/features/projects/activity";
import { listProjectActivity, listProjects } from "@/features/projects/queries.server";
import { PROJECT_STATUSES, type ProjectListItem, type ProjectStatus } from "@/features/projects/types";
import { canUseReviewInbox, type ReviewSummary } from "@/features/reviews/logic";
import { getReviewSummary } from "@/features/reviews/queries.server";
import { listSprints } from "@/features/sprints/queries.server";
import type { Sprint } from "@/features/sprints/types";
import { listWorkItems } from "@/features/work-items/queries.server";
import type { WorkItemListItem } from "@/features/work-items/types";

import { attentionReasons, isOpenWork, MY_WORK_ORDER, type AttentionReason } from "./logic";

/*
 * Home dashboard data (Phase 8H Part 1). Only existing reads, each scoped by
 * the database to what the signed-in employee may see. Per-project reads are
 * bounded (the most recently updated projects) and run in parallel. A read
 * that fails leaves its widget out; nothing is invented.
 */

const SPRINT_PROJECTS = 6;
const ACTIVITY_PROJECTS = 3;
const WORK_PROJECTS = 6;

export type ProjectRef = { id: string; name: string; projectKey: string };
export type ActiveSprint = { project: ProjectRef; sprint: Sprint };
export type ActivityItem = { project: ProjectRef; entry: ActivityEntry };
export type MyWorkItem = { project: ProjectRef; item: WorkItemListItem };
export type AttentionItem = { project: ProjectListItem; reasons: AttentionReason[] };

export type DashboardData = {
  role: AppRole;
  firstName: string;
  today: string;
  projects: { items: ProjectListItem[]; total: number } | null;
  projectStatusCounts: Record<ProjectStatus, number> | null;
  employees: { active: number; inactive: number; byRole: Record<AppRole, number> } | null;
  reviews: ReviewSummary | null;
  activeSprints: ActiveSprint[] | null;
  attention: AttentionItem[] | null;
  activity: ActivityItem[] | null;
  myWork: { items: MyWorkItem[]; open: number; scannedProjects: number } | null;
  notifications: { recent: Notification[]; unread: number } | null;
};

async function safe<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    console.error(`[dashboard] widget read failed: ${error instanceof Error ? error.name : "unknown"}`);
    return null;
  }
}

const ref = (project: ProjectListItem): ProjectRef => ({ id: project.id, name: project.name, projectKey: project.projectKey });

function projectsQuery(overrides: Partial<Parameters<typeof listProjects>[0]> = {}): Parameters<typeof listProjects>[0] {
  return { search: "", status: null, priority: null, archived: false, sort: "updated_desc", view: "grid", page: 1, pageSize: 12, ...overrides };
}

export async function loadDashboard(): Promise<DashboardData> {
  const { profile } = await requireActiveProfile();
  const role = profile.role;
  const today = new Date().toISOString().slice(0, 10);
  const firstName = profile.full_name?.trim().split(/\s+/)[0] || "there";
  const isAdmin = role === "SUPER_ADMIN";

  const projects = await safe(async () => {
    const page = await listProjects(projectsQuery());
    return { items: page.items, total: page.total };
  });
  const recent = projects?.items ?? [];

  const [projectStatusCounts, employees, reviews, activeSprints, activity, myWork, notifications, attentionCandidates] = await Promise.all([
    // Super Admin: projects per status (one bounded count read per status).
    isAdmin ? safe(async () => {
      const counts = await Promise.all(PROJECT_STATUSES.map((status) => listProjects(projectsQuery({ status, pageSize: 1 })).then((page) => page.total)));
      return Object.fromEntries(PROJECT_STATUSES.map((status, index) => [status, counts[index]])) as Record<ProjectStatus, number>;
    }) : Promise.resolve(null),

    // Super Admin: employees per role (active) and inactive.
    isAdmin ? safe(async () => {
      const count = (roleFilter: AppRole | null, status: "active" | "inactive") =>
        listEmployees({ search: "", role: roleFilter, status, page: 1, pageSize: 1 }).then((page) => page.total);
      const [superAdmins, managers, developers, inactive] = await Promise.all([
        count("SUPER_ADMIN", "active"), count("PROJECT_MANAGER", "active"), count("DEVELOPER", "active"), count(null, "inactive"),
      ]);
      return { active: superAdmins + managers + developers, inactive, byRole: { SUPER_ADMIN: superAdmins, PROJECT_MANAGER: managers, DEVELOPER: developers } };
    }) : Promise.resolve(null),

    canUseReviewInbox(role) ? safe(() => getReviewSummary()) : Promise.resolve(null),

    // Active sprints of the most recently updated projects.
    safe(async () => {
      const pages = await Promise.all(recent.slice(0, SPRINT_PROJECTS).map((project) =>
        listSprints(project.id, "open", 1, 10).then((page) => page.sprints.filter((sprint) => sprint.status === "ACTIVE").map((sprint) => ({ project: ref(project), sprint })))));
      return pages.flat();
    }),

    // Recent activity across the most recently updated projects.
    safe(async () => {
      const pages = await Promise.all(recent.slice(0, ACTIVITY_PROJECTS).map((project) =>
        listProjectActivity(project.id).then((page) => page.entries.map((entry) => ({ project: ref(project), entry })))));
      return pages.flat().sort((a, b) => Date.parse(b.entry.createdAt) - Date.parse(a.entry.createdAt)).slice(0, 8);
    }),

    // Developer: open work assigned to me in my most recently updated projects.
    role === "DEVELOPER" ? safe(async () => {
      const scanned = recent.slice(0, WORK_PROJECTS);
      const pages = await Promise.all(scanned.map((project) => listWorkItems(project.id, {
        search: "", type: null, status: null, priority: null, assignee: { kind: "person", id: profile.id }, archived: false, sort: "updated_desc", page: 1, pageSize: 25,
      }).then((page) => page.items.filter(isOpenWork).map((item) => ({ project: ref(project), item })))));
      const open = pages.flat();
      const items = open.sort((a, b) => MY_WORK_ORDER[a.item.status] - MY_WORK_ORDER[b.item.status] || Date.parse(b.item.updatedAt) - Date.parse(a.item.updatedAt)).slice(0, 8);
      return { items, open: open.length, scannedProjects: scanned.length };
    }) : Promise.resolve(null),

    safe(async () => {
      const [page, unread] = await Promise.all([listNotifications("all", null, null, 5), getUnreadCount()]);
      return { recent: page.notifications, unread };
    }),

    // Super Admin: candidates for "needs attention" (on hold, or past the target date).
    isAdmin ? safe(async () => {
      const [onHold, byTarget] = await Promise.all([
        listProjects(projectsQuery({ status: "on_hold", pageSize: 10 })),
        listProjects(projectsQuery({ sort: "target_asc", pageSize: 20 })),
      ]);
      return [...onHold.items, ...byTarget.items];
    }) : Promise.resolve(null),
  ]);

  let attention: AttentionItem[] | null = null;
  if (isAdmin && attentionCandidates) {
    const seen = new Map<string, ProjectListItem>();
    for (const project of [...attentionCandidates, ...recent]) seen.set(project.id, project);
    // Projects with reviews waiting 3+ days also need attention (from the review summary).
    const reviewAges = new Map((reviews?.projects ?? []).map((facet) => [facet.id ?? "", facet.oldestSubmittedAt]));
    attention = [...seen.values()]
      .map((project) => ({ project, reasons: attentionReasons(project, today, reviewAges.get(project.id) ?? null, Date.now()) }))
      .filter((entry) => entry.reasons.length > 0)
      .slice(0, 6);
  }

  return { role, firstName, today, projects, projectStatusCounts, employees, reviews, activeSprints, attention, activity, myWork, notifications };
}
