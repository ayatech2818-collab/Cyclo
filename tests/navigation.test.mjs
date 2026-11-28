import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const nav = await import("../src/components/layout/navigation.ts");
const dashboard = await import("../src/features/dashboard/logic.ts");

const P = "00000000-0000-4000-a000-0000000000a1";
const Q = "00000000-0000-4000-a000-0000000000a2";
const USER = "00000000-0000-4000-a000-000000000001";
const ids = (items) => items.map((item) => item.id);
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("each role sees only the entries its existing permissions allow", () => {
  assert.deepEqual(ids(nav.workspaceNav("SUPER_ADMIN")), ["dashboard", "projects", "reviews", "notifications"]);
  assert.deepEqual(ids(nav.workspaceNav("PROJECT_MANAGER")), ["dashboard", "projects", "reviews", "notifications"]);
  assert.deepEqual(ids(nav.workspaceNav("DEVELOPER")), ["dashboard", "projects", "notifications"], "no Reviews for developers");
  assert.deepEqual(ids(nav.managementNav("SUPER_ADMIN")), ["employees", "settings"]);
  assert.deepEqual(ids(nav.managementNav("PROJECT_MANAGER")), ["employees", "settings"]);
  assert.deepEqual(ids(nav.managementNav("DEVELOPER")), ["settings"], "no Employees for developers");
});

test("every entry is an existing route; no analytics or placeholder pages", () => {
  const routes = new Set(["/dashboard", "/projects", "/reviews", "/notifications", "/employees", "/profile"]);
  for (const role of ["SUPER_ADMIN", "PROJECT_MANAGER", "DEVELOPER"]) {
    for (const item of [...nav.workspaceNav(role), ...nav.managementNav(role)]) assert.ok(routes.has(item.href), item.href);
  }
  assert.deepEqual(nav.projectNav(P).map((item) => item.href), [
    `/projects/${P}`, `/projects/${P}/work`, `/projects/${P}/backlog`, `/projects/${P}/sprints`, `/projects/${P}/team`, `/projects/${P}/activity`,
  ]);
  const sidebar = read("../src/components/layout/sidebar.tsx");
  assert.doesNotMatch(sidebar, /analytics|inbox/i);
});

test("exactly one entry is active for a path", () => {
  const cases = {
    "/dashboard": "dashboard",
    "/projects": "projects",
    "/projects/new": "projects",
    [`/projects/${P}`]: "project-overview",
    [`/projects/${P}/edit`]: "project-overview",
    [`/projects/${P}/work`]: "project-work",
    [`/projects/${P}/work/${Q}`]: "project-work",
    [`/projects/${P}/backlog`]: "project-backlog",
    [`/projects/${P}/sprints/${Q}/board`]: "project-sprints",
    [`/projects/${P}/team`]: "project-team",
    [`/projects/${P}/activity`]: "project-activity",
    "/reviews": "reviews",
    "/notifications": "notifications",
    "/notifications/settings": "settings",
    "/profile": "settings",
    "/employees": "employees",
    "/employees/invitations": "employees",
    [`/employees/${Q}`]: "employees",
  };
  for (const [path, id] of Object.entries(cases)) assert.equal(nav.activeNavId(path), id, path);
  assert.equal(nav.activeNavId("/onboarding"), null);
});

test("project ids, switching and header titles", () => {
  assert.equal(nav.projectIdFromPath(`/projects/${P.toUpperCase()}/backlog`), P);
  assert.equal(nav.projectIdFromPath("/projects/new"), null);
  assert.equal(nav.projectIdFromPath("/reviews"), null);
  assert.equal(nav.switchTarget(`/projects/${P}/backlog`, Q), `/projects/${Q}/backlog`, "stay in the same section");
  assert.equal(nav.switchTarget(`/projects/${P}/work/${Q}`, Q), `/projects/${Q}/work`, "a work item falls back to the list");
  assert.equal(nav.switchTarget("/reviews", Q), `/projects/${Q}`, "outside a project: overview");
  assert.deepEqual(nav.pageTitle("/dashboard", null), { title: "Dashboard", parent: null });
  assert.deepEqual(nav.pageTitle(`/projects/${P}/backlog`, { id: P, name: "Checkout" }), { title: "Backlog", parent: { label: "Checkout", href: `/projects/${P}` } });
  assert.equal(nav.pageTitle(`/projects/${P}/sprints/${Q}/board`, null).title, "Sprint board");
  assert.equal(nav.pageTitle(`/projects/${P}/work/${Q}`, { id: Q, name: "Other" }).parent.label, "Project", "never shows another project's name");
  assert.deepEqual(nav.pageTitle("/notifications/settings", null).parent, { label: "Settings", href: "/profile" });
});

test("the remembered project belongs to the person who chose it", () => {
  const value = nav.lastProjectValue(USER, P);
  assert.equal(nav.parseLastProject(value, USER), P);
  assert.equal(nav.parseLastProject(value, "00000000-0000-4000-a000-000000000002"), null, "another user on the same browser");
  for (const bad of [undefined, "", "junk", `${USER}.not-a-uuid`, `${USER}`]) assert.equal(nav.parseLastProject(bad, USER), null);
  const layout = read("../src/app/(dashboard)/layout.tsx");
  assert.match(layout, /getProjectSummaryAction\(lastProjectId\)/, "re-checked against current access on the server");
});

test("dashboard rules use real state only", () => {
  const today = "2026-11-28";
  const now = Date.parse("2026-11-28T12:00:00Z");
  assert.deepEqual(dashboard.attentionReasons({ status: "active", targetDate: "2026-12-10" }, today, null, now), []);
  assert.deepEqual(dashboard.attentionReasons({ status: "on_hold", targetDate: null }, today, null, now).map((reason) => reason.kind), ["on_hold"]);
  assert.equal(dashboard.attentionReasons({ status: "active", targetDate: "2026-11-25" }, today, null, now)[0].label, "Past target date by 3 days");
  assert.deepEqual(dashboard.attentionReasons({ status: "completed", targetDate: "2026-11-01" }, today, null, now), [], "finished projects are not overdue");
  assert.deepEqual(dashboard.attentionReasons({ status: "active", targetDate: null }, today, "2026-11-24T10:00:00Z", now).map((reason) => reason.kind), ["reviews_waiting"]);
  assert.deepEqual(dashboard.attentionReasons({ status: "active", targetDate: null }, today, "2026-11-27T10:00:00Z", now), [], "a 1-day-old review is fine");
  assert.equal(dashboard.sprintCompletion({ estimateTotal: 20, doneEstimate: 5, itemCount: 4, doneCount: 3 }), 25, "points when estimated");
  assert.equal(dashboard.sprintCompletion({ estimateTotal: 0, doneEstimate: 0, itemCount: 4, doneCount: 3 }), 75, "items otherwise");
  assert.equal(dashboard.sprintCompletion({ estimateTotal: 0, doneEstimate: 0, itemCount: 0, doneCount: 0 }), 0);
  assert.equal(dashboard.daysLeft("2026-12-01", today), 3);
  assert.equal(dashboard.daysLeft("2026-11-27", today), -1);
  assert.equal(dashboard.daysLeft(null, today), null);
  assert.equal(dashboard.isOpenWork({ status: "DONE" }), false);
  assert.ok(dashboard.MY_WORK_ORDER.BLOCKED < dashboard.MY_WORK_ORDER.IN_PROGRESS);
  const queries = read("../src/features/dashboard/queries.server.ts");
  assert.doesNotMatch(queries, /\.rpc\(/, "no new database calls: only existing query helpers");
});
