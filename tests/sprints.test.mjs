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

const logic = await import("../src/features/sprints/logic.ts");
const types = await import("../src/features/sprints/types.ts");
const activity = await import("../src/features/projects/activity.ts");
const { mapProjectDatabaseError, ProjectError } = await import("../src/features/projects/errors.ts");

const { toSprint, toSprintItem, toCapacityRow, validateSprintFields, parseCapacity, capacityState, sprintDurationDays, startBlocker, parseSelection, isOpenSprint } = logic;
const migration = readFileSync(new URL("../supabase/migrations/20261130100000_sprint_management.sql", import.meta.url), "utf8");
const ID = "00000000-0000-4000-a000-000000000001";

const sprintRow = {
  id: ID, name: "Sprint 1", goal: null, status: "PLANNING", start_date: "2027-01-04", end_date: "2027-01-18",
  capacity_points: "20.0", started_at: null, completed_at: null, cancelled_at: null, created_at: "2026-11-30T10:00:00Z",
  item_count: 4, done_count: 1, estimate_total: "13.5", done_estimate: null, unestimated_count: 1, total_count: 3, secret: "x",
};

test("statuses mirror the database enum", () => {
  assert.match(migration, /create type public\.sprint_status as enum \('PLANNING', 'ACTIVE', 'COMPLETED', 'CANCELLED'\)/);
  assert.deepEqual(types.SPRINT_STATUSES, ["PLANNING", "ACTIVE", "COMPLETED", "CANCELLED"]);
  assert.equal(isOpenSprint("ACTIVE"), true);
  assert.equal(isOpenSprint("COMPLETED"), false);
});

test("rows parse strictly into DTOs", () => {
  const sprint = toSprint(sprintRow);
  assert.equal(sprint.capacity, 20);
  assert.equal(sprint.estimateTotal, 13.5);
  assert.equal(sprint.doneEstimate, 0);
  assert.equal("secret" in sprint, false);
  assert.throws(() => toSprint({ ...sprintRow, status: "DONE" }), ProjectError);
  assert.throws(() => toSprint({ ...sprintRow, item_count: -1 }), ProjectError);
  assert.throws(() => toSprintItem({ id: ID, issue_key: "K-1", type: "TASK", title: "t", status: "done", priority: "low" }), ProjectError);
  assert.deepEqual(toCapacityRow({ assignee_id: null, assignee_name: null, item_count: 2, estimate_total: null, unestimated_count: 2 }),
    { assigneeId: null, assigneeName: null, itemCount: 2, estimate: 0, unestimated: 2 });
});

test("form validation mirrors the database rules", () => {
  assert.deepEqual(validateSprintFields({ name: "  Sprint 2 ", goal: " ", startDate: "", endDate: "" }, { requireDates: false }),
    { ok: true, values: { name: "Sprint 2", goal: null, startDate: null, endDate: null } });
  assert.ok(validateSprintFields({ name: "" }, { requireDates: false }).errors.name);
  assert.ok(validateSprintFields({ name: "x".repeat(81) }, { requireDates: false }).errors.name);
  assert.ok(validateSprintFields({ name: "a\nb" }, { requireDates: false }).errors.name);
  assert.ok(validateSprintFields({ name: "S", startDate: "2027-01-10", endDate: "2027-01-10" }, { requireDates: false }).errors.endDate, "start must be before end");
  assert.ok(validateSprintFields({ name: "S", startDate: "2027-01-10" }, { requireDates: true }).errors.endDate, "active sprints need both dates");
  assert.ok(validateSprintFields({ name: "S", goal: "g".repeat(2001) }, { requireDates: false }).errors.goal);
  assert.match(migration, /start_date is null or end_date is null or start_date < end_date/);
});

test("capacity input and state (never invented, warning only)", () => {
  assert.equal(parseCapacity(""), null);
  assert.equal(parseCapacity("30"), 30);
  assert.equal(parseCapacity("12.5"), 12.5);
  for (const bad of ["-1", "1.25", "10001", "abc"]) assert.equal(parseCapacity(bad), "invalid", bad);
  assert.deepEqual(capacityState(13, null), { kind: "unset", planned: 13 });
  assert.deepEqual(capacityState(10, 20), { kind: "within", planned: 10, capacity: 20, ratio: 0.5 });
  assert.deepEqual(capacityState(23.5, 20), { kind: "over", planned: 23.5, capacity: 20, ratio: 1.175, overBy: 3.5 });
  assert.equal(capacityState(1, 0).kind, "over");
});

test("duration and start gates mirror private.start_sprint", () => {
  assert.equal(sprintDurationDays("2027-01-04", "2027-01-18"), 14);
  assert.equal(sprintDurationDays(null, "2027-01-18"), null);
  const ready = { status: "PLANNING", startDate: "2027-01-04", endDate: "2027-01-18", itemCount: 3 };
  assert.equal(startBlocker(ready, false), null);
  assert.match(startBlocker({ ...ready, itemCount: 0 }, false), /at least one/);
  assert.match(startBlocker({ ...ready, endDate: null }, false), /start and end date/);
  assert.match(startBlocker(ready, true), /active sprint/);
  assert.match(startBlocker({ ...ready, status: "ACTIVE" }, false), /Only planned/);
  assert.match(migration, /raise exception using errcode = '22023', message = 'sprint_empty'/);
});

test("selections are 1..100 distinct uuids", () => {
  assert.deepEqual(parseSelection([ID.toUpperCase()]), [ID]);
  assert.equal(parseSelection([]), null);
  assert.equal(parseSelection([ID, ID]), null);
  assert.equal(parseSelection(["1 or 1=1"]), null);
  assert.equal(parseSelection(Array.from({ length: 101 }, () => ID)), null);
});

test("sprint errors map to specific messages", () => {
  assert.equal(mapProjectDatabaseError({ code: "23505", message: "active_sprint_exists" }), "active_sprint_exists");
  assert.equal(mapProjectDatabaseError({ code: "23505", message: "already_in_sprint" }), "already_in_sprint");
  assert.equal(mapProjectDatabaseError({ code: "55000", message: "sprint_closed" }), "sprint_closed");
  assert.equal(mapProjectDatabaseError({ code: "22023", message: "sprint_empty" }), "sprint_empty");
  assert.equal(mapProjectDatabaseError({ code: "22023", message: "unfinished_work_requires_decision" }), "unfinished_work_requires_decision");
  assert.equal(mapProjectDatabaseError({ code: "22023", message: "not_schedulable" }), "not_schedulable");
  assert.equal(mapProjectDatabaseError({ code: "P0002", message: "sprint_not_found" }), "not_found");
});

test("sprint events read as sentences", () => {
  const say = (action, extra = {}) => activity.describeActivity({ action, subjectName: null, previousSubjectName: null, changes: [], workItem: { id: ID, issueKey: "K-7", title: "x" }, sprint: { id: ID, name: "Sprint 4" }, ...extra });
  assert.equal(say("SPRINT_STARTED"), "started Sprint 4");
  assert.equal(say("SPRINT_CANCELLED"), "cancelled Sprint 4");
  assert.equal(say("SPRINT_COMPLETED", { changes: [{ field: "carried_over", from: null, to: "2" }], previousSubjectName: "Sprint 5" }), "completed Sprint 4 and carried 2 unfinished items to Sprint 5");
  assert.equal(say("SPRINT_COMPLETED", { changes: [{ field: "carried_over", from: null, to: "1" }] }), "completed Sprint 4 and carried 1 unfinished item to the backlog");
  assert.equal(say("WORK_ITEM_ADDED_TO_SPRINT", { subjectName: "Sprint 4" }), "added K-7 to Sprint 4");
  assert.equal(say("WORK_ITEM_REMOVED_FROM_SPRINT", { subjectName: "Sprint 4" }), "returned K-7 from Sprint 4 to the backlog");
  assert.equal(say("WORK_ITEM_MOVED_BETWEEN_SPRINTS", { subjectName: "Sprint 5", previousSubjectName: "Sprint 4" }), "moved K-7 from Sprint 4 to Sprint 5");
  assert.deepEqual(activity.activityDetails({ action: "SPRINT_CAPACITY_CHANGED", changes: [{ field: "capacity_points", from: "10.0", to: "20" }] }),
    [{ label: "Capacity", from: "10 pts", to: "20 pts" }]);
  assert.deepEqual(activity.activityDetails({ action: "SPRINT_UPDATED", changes: [{ field: "goal", from: null, to: null }] }), [{ label: "Goal", from: null, to: "Updated" }]);
});

test("migration guarantees: one active sprint, no deletes, frozen history, no status side effects", () => {
  assert.match(migration, /create unique index sprints_one_active_per_project on public\.sprints \(project_id\) where status = 'ACTIVE'/);
  assert.match(migration, /create trigger sprints_prevent_delete/);
  assert.match(migration, /if old\.status in \('COMPLETED', 'CANCELLED'\) then/);
  const lifecycle = migration.slice(migration.indexOf("create function private.start_sprint"), migration.indexOf("-- Activity change details"));
  assert.doesNotMatch(lifecycle, /set status = 'IN_PROGRESS'|set status = 'DONE'|delete from public\.work_items/);
  assert.doesNotMatch(migration, /grant[^;]*(insert|update|delete)[^;]*on table public\.sprints to (authenticated|service_role)/i);
});
