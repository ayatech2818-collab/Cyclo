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

const execution = await import("../src/features/work-items/execution.ts");
const burndown = await import("../src/features/sprints/burndown.ts");
const { mapProjectDatabaseError, ProjectError } = await import("../src/features/projects/errors.ts");

const {
  availableMoves, executionActionFor, moveForColumn, boardColumnOf, groupBoard, filterBoard, patchBoardItem, optimisticPatch,
  parseReason, toBoardItem, toExecutionResult, toSprintProgress, toExecutionContext, completionPercent, isExecutionAction, BOARD_COLUMNS,
} = execution;
const { buildBurndown, idealLine, sprintDays, isWeekend, toBurndownDay } = burndown;

const migration = readFileSync(new URL("../supabase/migrations/20261201100000_sprint_execution.sql", import.meta.url), "utf8");
const DEV = "00000000-0000-4000-a000-0000000000d1";
const OTHER = "00000000-0000-4000-a000-0000000000d2";
const PM = "00000000-0000-4000-a000-0000000000a1";
const dev = { id: DEV, isManager: false, writable: true };
const pm = { id: PM, isManager: true, writable: true };
const mine = (status, blockedFromStatus = null) => ({ status, blockedFromStatus, assigneeId: DEV });
const moves = (item, viewer) => availableMoves(item, viewer).map((move) => `${move.action ?? "status"}:${move.to}`);

test("execution actions mirror execute_work_item", () => {
  const sql = migration.slice(migration.indexOf("create function private.execute_work_item"));
  const actions = sql.slice(sql.indexOf("not in ("), sql.indexOf(") then")).match(/'([a-z_]+)'/g).map((value) => value.slice(1, -1));
  assert.deepEqual(actions, [...execution.EXECUTION_ACTIONS]);
  assert.equal(isExecutionAction("approve"), true);
  assert.equal(isExecutionAction("done"), false);
  assert.equal(executionActionFor("TODO", "IN_PROGRESS", null), "start");
  assert.equal(executionActionFor("IN_PROGRESS", "IN_REVIEW", null), "submit_review");
  assert.equal(executionActionFor("IN_REVIEW", "BLOCKED", null), "block");
  assert.equal(executionActionFor("BLOCKED", "IN_REVIEW", "IN_REVIEW"), "resume");
  assert.equal(executionActionFor("BLOCKED", "CANCELLED", "IN_REVIEW"), null);
  assert.equal(executionActionFor("IN_REVIEW", "DONE", null), "approve");
  assert.equal(executionActionFor("IN_REVIEW", "IN_PROGRESS", null), "reject");
  assert.equal(executionActionFor("BACKLOG", "TODO", null), null);
});

test("developers move only their own work and never decide reviews", () => {
  assert.deepEqual(moves(mine("TODO"), dev), ["status:BACKLOG", "start:IN_PROGRESS", "block:BLOCKED"]);
  assert.deepEqual(moves(mine("IN_PROGRESS"), dev), ["status:TODO", "submit_review:IN_REVIEW", "block:BLOCKED"]);
  assert.deepEqual(moves(mine("IN_REVIEW"), dev), ["block:BLOCKED"], "submitting never leads to Done; no approve/reject");
  assert.deepEqual(moves(mine("BLOCKED", "IN_PROGRESS"), dev), ["resume:IN_PROGRESS"], "resume returns to the previous status only");
  assert.deepEqual(moves(mine("DONE"), dev), [], "no reopen");
  assert.deepEqual(moves(mine("CANCELLED"), dev), []);
  assert.deepEqual(moves({ status: "TODO", blockedFromStatus: null, assigneeId: OTHER }, dev), [], "others' tasks are read-only");
  assert.deepEqual(moves({ status: "TODO", blockedFromStatus: null, assigneeId: null }, dev), []);
  assert.deepEqual(moves(mine("TODO"), { ...dev, writable: false }), [], "read-only sprint or archived project");
  assert.ok(availableMoves(mine("TODO"), dev).every((move) => move.to !== "CANCELLED"));
});

test("managers approve, request changes and cancel", () => {
  assert.deepEqual(moves(mine("IN_REVIEW"), pm), ["reject:IN_PROGRESS", "approve:DONE", "block:BLOCKED", "status:CANCELLED"]);
  assert.deepEqual(moves(mine("DONE"), pm), ["status:IN_PROGRESS"]);
  const [reject] = availableMoves(mine("IN_REVIEW"), pm);
  assert.equal(reject.needsReason, true);
  assert.equal(reject.label, "Request changes");
  const start = availableMoves(mine("TODO"), dev).find((move) => move.action === "start");
  assert.ok(start.confirm, "starting work asks for confirmation");
  const block = availableMoves(mine("TODO"), dev).find((move) => move.action === "block");
  assert.equal(block.needsReason, true);
  const cancel = availableMoves(mine("TODO"), pm).find((move) => move.to === "CANCELLED");
  assert.ok(cancel.confirm);
});

test("reasons are trimmed and bounded like the database", () => {
  assert.equal(parseReason("  Waiting on API keys  "), "Waiting on API keys");
  assert.equal(parseReason("ok"), null);
  assert.equal(parseReason("x".repeat(500)), "x".repeat(500));
  assert.equal(parseReason("x".repeat(501)), null);
  assert.equal(parseReason("line\nbreak"), null);
  assert.equal(parseReason(null), null);
});

test("board columns, drops and grouping", () => {
  assert.deepEqual([...BOARD_COLUMNS], ["TODO", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "DONE"]);
  assert.equal(boardColumnOf("BACKLOG"), "TODO");
  assert.equal(boardColumnOf("CANCELLED"), null);
  assert.equal(moveForColumn(mine("TODO"), "IN_PROGRESS", dev).action, "start");
  assert.equal(moveForColumn(mine("TODO"), "DONE", dev), null, "no skipping the workflow");
  assert.equal(moveForColumn(mine("IN_REVIEW"), "DONE", dev), null, "developers cannot drop into Done");
  assert.equal(moveForColumn(mine("IN_REVIEW"), "DONE", pm).action, "approve");
  assert.equal(moveForColumn(mine("IN_REVIEW"), "IN_PROGRESS", pm).action, "reject");
  assert.equal(moveForColumn(mine("BLOCKED", "TODO"), "TODO", dev).action, "resume");
  assert.equal(moveForColumn(mine("BLOCKED", "TODO"), "IN_PROGRESS", dev), null);
  assert.equal(moveForColumn(mine("BACKLOG"), "TODO", dev), null, "already in the To do column");
  assert.equal(moveForColumn(mine("TODO"), "TODO", dev), null);

  const card = (id, status, estimate, extra = {}) => ({
    id, issueKey: `EXA-${id}`, type: "TASK", title: `Item ${id}`, status, blockedFromStatus: null, blockedReason: null,
    priority: "medium", assigneeId: DEV, assigneeName: "Dev", estimate, rank: Number(id), updatedAt: "2026-11-26T10:00:00Z", ...extra,
  });
  const items = [card("1", "TODO", 3), card("2", "BACKLOG", null), card("3", "IN_PROGRESS", 2.5), card("4", "DONE", 5), card("5", "CANCELLED", 8),
    card("6", "IN_PROGRESS", 1, { assigneeId: OTHER, type: "BUG", priority: "critical", title: "Crash on login" })];
  const groups = groupBoard(items);
  assert.deepEqual(groups.map((group) => [group.column, group.count, group.points, group.unestimated]), [
    ["TODO", 2, 3, 1], ["IN_PROGRESS", 2, 3.5, 0], ["IN_REVIEW", 0, 0, 0], ["BLOCKED", 0, 0, 0], ["DONE", 1, 5, 0],
  ], "cancelled work is not on the board");
  assert.deepEqual(filterBoard(items, { search: "login", assignee: "any", type: null, priority: null }, DEV).map((item) => item.id), ["6"]);
  assert.deepEqual(filterBoard(items, { search: "exa-4", assignee: "any", type: null, priority: null }, DEV).map((item) => item.id), ["4"]);
  assert.deepEqual(filterBoard(items, { search: "", assignee: "mine", type: null, priority: null }, OTHER).map((item) => item.id), ["6"]);
  assert.deepEqual(filterBoard(items, { search: "", assignee: "any", type: "BUG", priority: "critical" }, DEV).map((item) => item.id), ["6"]);

  // Same numbers as private.sprint_progress for the same cards (cancelled excluded, floor).
  const live = execution.summarizeBoard(items.filter((item) => item.status !== "CANCELLED"), 1);
  assert.deepEqual(live, { totalItems: 5, completedItems: 1, remainingItems: 4, cancelledItems: 1, totalPoints: 11.5, completedPoints: 5, remainingPoints: 6.5, unestimatedItems: 1, completionPercent: 43 });

  const blocked = optimisticPatch(items[2], availableMoves(items[2], dev).find((move) => move.action === "block"), "Waiting");
  assert.deepEqual(blocked, { status: "BLOCKED", blockedFromStatus: "IN_PROGRESS", blockedReason: "Waiting" });
  const patched = patchBoardItem(items, "3", blocked);
  assert.equal(patched[2].status, "BLOCKED");
  assert.equal(items[2].status, "IN_PROGRESS", "the original list is untouched (rollback source)");
});

test("rows parse strictly", () => {
  const row = {
    id: OTHER, issue_key: "EXA-1", type: "TASK", title: "T", status: "BLOCKED", blocked_from_status: "TODO", blocked_reason: "Waiting",
    priority: "high", assignee_id: DEV, assignee_name: "Dev", estimate: "2.5", backlog_rank: 1000, updated_at: "2026-11-26T10:00:00Z",
  };
  const item = toBoardItem(row);
  assert.equal(item.estimate, 2.5);
  assert.equal(item.blockedFromStatus, "TODO");
  assert.throws(() => toBoardItem({ ...row, status: "DONE!" }), ProjectError);

  const result = toExecutionResult({ id: OTHER, status: "IN_PROGRESS", blocked_from_status: null, blocked_reason: null, updated_at: "2026-11-26T10:00:00Z", changed: false });
  assert.equal(result.changed, false);
  assert.throws(() => toExecutionResult({ id: OTHER, status: "IN_PROGRESS", updated_at: "x", changed: "yes" }), ProjectError);

  const summary = (scope, extra) => ({
    scope, total_items: 4, completed_items: 1, remaining_items: 3, cancelled_items: 1, total_points: "15", completed_points: "5",
    remaining_points: "10", unestimated_items: 1, completion_percent: 33, assignee_id: null, assignee_name: null, ...extra,
  });
  const progress = toSprintProgress([summary("total"), summary("assignee", { assignee_id: DEV, assignee_name: "Dev" })]);
  assert.equal(progress.total.completionPercent, 33);
  assert.equal(progress.byAssignee[0].assigneeName, "Dev");
  assert.equal(completionPercent(progress.total), 33, "UI and database compute completion the same way");
  assert.equal(completionPercent({ totalPoints: 0, completedPoints: 0, totalItems: 3, completedItems: 2 }), 66, "item count without estimates");
  assert.equal(completionPercent({ totalPoints: 0, completedPoints: 0, totalItems: 0, completedItems: 0 }), 0);
  assert.throws(() => toSprintProgress([summary("other")]), ProjectError);
  assert.deepEqual(toSprintProgress([]).total.totalItems, 0);

  const context = toExecutionContext({
    sprint_id: OTHER, sprint_name: "Sprint 1", sprint_status: "ACTIVE", blocked_reason: null,
    last_review_action: "WORK_ITEM_REVIEW_REJECTED", last_review_reason: "Missing tests", last_review_at: "2026-11-26T10:00:00Z", last_review_by: "Pat",
  });
  assert.deepEqual(context.lastReview, { decision: "rejected", reason: "Missing tests", at: "2026-11-26T10:00:00Z", by: "Pat" });
  assert.equal(toExecutionContext({ sprint_id: null, sprint_name: null, sprint_status: null, blocked_reason: null, last_review_action: null }).lastReview, null);
  assert.throws(() => toExecutionContext({ sprint_status: "ACTIVE", last_review_action: "WORK_ITEM_CREATED", last_review_at: "x" }), ProjectError);
});

test("execution errors map to safe messages", () => {
  assert.equal(mapProjectDatabaseError({ code: "55000", message: "status_changed" }), "status_changed");
  assert.notEqual(mapProjectDatabaseError({ code: "40001", message: "status_changed" }), "status_changed");
  for (const code of ["reason_required", "blocked_reason_required", "review_reason_required", "invalid_action"]) {
    assert.equal(mapProjectDatabaseError({ code: "22023", message: code }), code);
  }
  assert.match(new ProjectError("reason_required").message, /3–500/);
});

test("burndown: working days, ideal line and missing data", () => {
  assert.equal(isWeekend("2026-11-28"), true); // Saturday
  assert.equal(isWeekend("2026-11-30"), false);
  // Fri 27 Nov → Fri 4 Dec 2026: burn days after the start are Mon–Fri (5).
  const days = sprintDays("2026-11-27", "2026-12-04");
  assert.equal(days.length, 8);
  assert.deepEqual(idealLine(days, 10), [10, 10, 10, 8, 6, 4, 2, 0], "flat over the weekend, zero on the last day");
  assert.deepEqual(idealLine(sprintDays("2026-11-28", "2026-11-29"), 4), [4, 0], "no working days → calendar days");
  assert.deepEqual(sprintDays("2026-12-04", "2026-11-27"), []);

  const row = (day, hasData, remaining, scope = 10) => toBurndownDay({
    day, has_data: hasData, scope_points: hasData ? scope : null, completed_points: hasData ? scope - remaining : null,
    remaining_points: hasData ? remaining : null, remaining_items: hasData ? 2 : null, unestimated_items: hasData ? 0 : null,
  });
  assert.deepEqual(row("2026-11-27", false), { day: "2026-11-27", hasData: false }, "no numbers for a day without history");
  assert.throws(() => toBurndownDay({ day: "2026-11-27", has_data: false, remaining_points: 0 }), ProjectError, "a zero is never accepted as missing data");
  const chart = buildBurndown("2026-11-27", "2026-12-04", [row("2026-11-27", false, 0), row("2026-11-28", true, 10), row("2026-11-29", true, 10), row("2026-11-30", true, 6, 12)]);
  assert.equal(chart.points[0].status, "missing");
  assert.equal(chart.points[0].actual, null, "missing history is a gap, never zero");
  assert.equal(chart.missingDays, 1);
  assert.equal(chart.baselineScope, 10, "ideal starts from the first recorded scope");
  assert.equal(chart.points[3].actual, 6);
  assert.equal(chart.latest.day, "2026-11-30");
  assert.equal(chart.scopeChanged, true);
  assert.equal(chart.points[4].status, "future");
  assert.equal(chart.points[4].actual, null);
  assert.equal(chart.points.at(-1).ideal, 0);

  const none = buildBurndown("2026-11-27", "2026-12-04", [row("2026-11-27", false, 0)]);
  assert.equal(none.latest, null);
  assert.ok(none.points.every((point) => point.ideal === null), "no baseline → no invented ideal");
  assert.equal(buildBurndown(null, "2026-12-04", []).points.length, 0);
  assert.throws(() => toBurndownDay({ day: "2026-13-01", has_data: true }), ProjectError);
});
