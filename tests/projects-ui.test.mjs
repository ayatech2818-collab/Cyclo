import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const { projectSchedule } = await import("../src/features/projects/schedule.ts");
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const TODAY = "2026-11-28";

test("the project timeline comes only from the project's own dates and status", () => {
  const base = { status: "active", startDate: "2026-11-01", targetDate: "2026-12-31" };
  const running = projectSchedule(base, TODAY);
  assert.equal(running.label, "33 days left");
  assert.equal(running.tone, "neutral");
  assert.equal(running.elapsed, 45);

  assert.deepEqual(projectSchedule({ ...base, targetDate: "2026-12-05" }, TODAY).tone, "warning", "two weeks or less is close");
  assert.equal(projectSchedule({ ...base, targetDate: TODAY }, TODAY).label, "Due today");
  const late = projectSchedule({ ...base, targetDate: "2026-11-25" }, TODAY);
  assert.equal(late.label, "Overdue by 3 days");
  assert.equal(late.tone, "danger");
  assert.equal(late.elapsed, 100);

  assert.equal(projectSchedule({ ...base, startDate: "2026-12-02" }, TODAY).label, "Starts in 4 days");
  assert.equal(projectSchedule({ ...base, startDate: "2026-12-02" }, TODAY).elapsed, 0);
  assert.deepEqual(projectSchedule({ ...base, status: "completed", targetDate: "2026-11-20" }, TODAY), { elapsed: 100, label: "Completed", tone: "success" }, "finished projects are never overdue");
  assert.equal(projectSchedule({ ...base, status: "cancelled" }, TODAY).label, "Cancelled");
  assert.deepEqual(projectSchedule({ status: "planning", startDate: null, targetDate: null }, TODAY), { elapsed: null, label: null, tone: "neutral" });
  assert.equal(projectSchedule({ status: "active", startDate: null, targetDate: "2027-01-01" }, TODAY).elapsed, null, "no start date: no elapsed bar");
  assert.equal(projectSchedule({ status: "active", startDate: "2026-12-01", targetDate: "2026-12-01" }, TODAY).elapsed, null, "empty window");
  assert.equal(projectSchedule({ ...base, targetDate: "2026-11-29" }, TODAY).label, "1 day left");
});

test("the sidebar is the only project navigation", () => {
  assert.equal(existsSync(new URL("../src/features/projects/components/project-section-nav.tsx", import.meta.url)), false);
  const header = read("../src/features/projects/components/project-header.tsx");
  assert.doesNotMatch(header, /ProjectSectionNav|aria-label="Project sections"/);
  for (const section of ["activity", "backlog", "sprints", "team", "work"]) {
    assert.match(read(`../src/app/(dashboard)/projects/[projectId]/${section}/page.tsx`), new RegExp(`current="${section}"`), section);
  }
});

test("the overview uses existing, permission-scoped reads only", () => {
  const loader = read("../src/features/projects/overview.server.ts");
  assert.doesNotMatch(loader, /\.rpc\(|createClient/, "no new database calls");
  for (const name of ["getBacklogSummary", "listSprints", "listProjectMembers", "listProjectActivity"]) assert.match(loader, new RegExp(name));
  const page = read("../src/app/(dashboard)/projects/[projectId]/page.tsx");
  assert.match(page, /canManageProject\(profile, project\)/, "archive stays behind the existing check");
  assert.match(page, /canAssignProjectManager\(profile.role\)/, "reassigning stays Super Admin-only");
});

test("projects listing keeps every filter in the URL and adds no fake controls", () => {
  const filters = read("../src/features/projects/components/project-filters.tsx");
  assert.match(filters, /method="get" action="\/projects"/);
  for (const field of ['name="q"', 'name="priority"', 'name="sort"', 'name="status"', 'name="archived"', 'name="view"']) assert.ok(filters.includes(field), field);
  const collection = read("../src/features/projects/components/project-collection.tsx");
  assert.doesNotMatch(collection, /<button/, "cards and rows only link to real pages");
});

test("solid orange behind white text uses the darker action colour", () => {
  const css = read("../src/app/globals.css");
  assert.match(css, /--action: #c2410c;/);
  const styles = read("../src/components/ui/styles.ts");
  assert.match(styles, /primary: "bg-action [^"]*text-primary-foreground[^"]*hover:bg-action-hover"/);
});
