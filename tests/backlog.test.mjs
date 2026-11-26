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

const logic = await import("../src/features/backlog/logic.ts");
const types = await import("../src/features/backlog/types.ts");
const activity = await import("../src/features/projects/activity.ts");
const { ProjectError } = await import("../src/features/projects/errors.ts");

const {
  parseBacklogQuery, backlogQueryToParams, backlogHref, hasBacklogFilters, toBacklogItem, toBacklogSummary, groupBacklog,
  reorder, placementOf, validateQuickCreate, parseBulkChange, formatPoints,
} = logic;

const migration = readFileSync(new URL("../supabase/migrations/20261129100000_backlog_management.sql", import.meta.url), "utf8");
const P = "00000000-0000-4000-a000-0000000000aa";
const E1 = "00000000-0000-4000-a000-0000000000e1";
const U = "00000000-0000-4000-a000-000000000001";

const row = (n, overrides = {}) => ({
  id: `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`, issue_key: `BLA-${n}`, type: "TASK", title: `Item ${n}`,
  status: "BACKLOG", priority: "medium", assignee_id: null, assignee_name: null, estimate: null, backlog_rank: n * 1024,
  epic_id: null, epic_key: null, epic_title: null, subtask_count: 0, total_count: 9, ...overrides,
});

test("query: defaults, hostile input, round trip", () => {
  assert.deepEqual(parseBacklogQuery({}), {
    search: "", type: null, status: null, priority: null, assignee: { kind: "any" }, epic: { kind: "any" },
    includeCompleted: false, group: "none", page: 1, pageSize: 50,
  });
  const hostile = parseBacklogQuery({ type: "EPIC", group: "rank; drop", epic: "1=1", assignee: "x", size: "500", page: "-2" });
  assert.deepEqual([hostile.type, hostile.group, hostile.epic, hostile.assignee, hostile.pageSize, hostile.page],
    [null, "none", { kind: "any" }, { kind: "any" }, 50, 1], "epics are not backlog rows; unknown values fall back");
  const query = parseBacklogQuery({ q: "card", type: "BUG", status: "TODO", priority: "high", assignee: "none", epic: E1, completed: "1", group: "epic", page: "3", size: "25" });
  assert.deepEqual(parseBacklogQuery(Object.fromEntries(backlogQueryToParams(query))), query);
  assert.equal(backlogHref(P, parseBacklogQuery({})), `/projects/${P}/backlog`);
  assert.equal(hasBacklogFilters(parseBacklogQuery({ epic: "none" })), true);
  assert.equal(hasBacklogFilters(parseBacklogQuery({ group: "type", completed: "1" })), false, "grouping and completed are view options, not filters");
});

test("grouping options mirror private.list_backlog", () => {
  for (const group of types.BACKLOG_GROUPS) assert.ok(migration.includes(`'${group}'`), group);
  assert.match(migration, /w\.type in \('STORY', 'TASK', 'BUG'\)/);
  assert.deepEqual(types.BACKLOG_TYPES, ["STORY", "TASK", "BUG"]);
});

test("rows parse strictly", () => {
  const item = toBacklogItem(row(1, { estimate: "2.5", extra: "leak" }));
  assert.equal(item.estimate, 2.5);
  assert.equal("extra" in item, false);
  assert.equal("backlog_rank" in item, false, "rank values never reach the browser");
  assert.throws(() => toBacklogItem(row(1, { type: "EPIC" })), ProjectError);
  assert.throws(() => toBacklogItem(row(1, { subtask_count: -1 })), ProjectError);
});

test("summary rows fold into counts", () => {
  const summary = toBacklogSummary([
    { dimension: "total", key: "all", label: null, item_count: 9, estimate_total: "13.5" },
    { dimension: "status", key: "BACKLOG", label: null, item_count: 6, estimate_total: null },
    { dimension: "status", key: "TODO", label: null, item_count: 3, estimate_total: null },
    { dimension: "type", key: "BUG", label: null, item_count: 2, estimate_total: null },
    { dimension: "priority", key: "high", label: null, item_count: 4, estimate_total: null },
    { dimension: "assignee", key: "unassigned", label: null, item_count: 5, estimate_total: null },
    { dimension: "estimate", key: "unestimated", label: null, item_count: 7, estimate_total: null },
    { dimension: "epic", key: E1, label: "BLA-1 · Checkout", item_count: 4, estimate_total: 8 },
    { dimension: "epic", key: "none", label: null, item_count: 5, estimate_total: null },
    { dimension: "epic", key: "not-a-uuid", label: "x", item_count: 1, estimate_total: null },
  ]);
  assert.equal(summary.total, 9);
  assert.equal(summary.estimate, 13.5);
  assert.deepEqual(summary.byStatus, { BACKLOG: 6, TODO: 3 });
  assert.equal(summary.unassigned, 5);
  assert.equal(summary.unestimated, 7);
  assert.deepEqual(summary.epics, [{ id: E1, label: "BLA-1 · Checkout", count: 4, estimate: 8 }]);
  assert.equal(summary.withoutEpic, 5);
});

test("sections are contiguous and keep rank order", () => {
  const items = [
    row(1, { priority: "critical" }), row(2, { priority: "critical" }), row(3, { priority: "high" }), row(4, { priority: "low" }),
  ].map((value) => toBacklogItem(value));
  assert.deepEqual(groupBacklog(items, "priority").map((section) => [section.label, section.items.map((item) => item.issueKey)]),
    [["Critical", ["BLA-1", "BLA-2"]], ["High", ["BLA-3"]], ["Low", ["BLA-4"]]]);
  assert.deepEqual(groupBacklog(items, "none").map((section) => section.items.length), [4]);
  const epics = [row(1, { epic_id: E1, epic_key: "BLA-9", epic_title: "Checkout" }), row(2)].map((value) => toBacklogItem(value));
  assert.deepEqual(groupBacklog(epics, "epic").map((section) => section.label), ["BLA-9 · Checkout", "No epic"]);
});

test("drag placement: neighbours after the move, never array indexes", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(reorder(ids, 3, 1), ["a", "d", "b", "c"]);
  assert.deepEqual(placementOf(reorder(ids, 3, 1), "d"), { afterId: "a", beforeId: "b" });
  assert.deepEqual(placementOf(reorder(ids, 2, 0), "c"), { afterId: null, beforeId: "a" }, "to the top");
  assert.deepEqual(placementOf(reorder(ids, 0, 3), "a"), { afterId: "d", beforeId: null }, "to the bottom");
  assert.equal(placementOf(["only"], "only"), null);
  assert.equal(placementOf(ids, "zz"), null);
});

test("quick create and bulk input validation", () => {
  assert.deepEqual(validateQuickCreate("BUG", "  Crash on save  "), { ok: true, type: "BUG", title: "Crash on save" });
  assert.equal(validateQuickCreate("STORY", "x").ok, false, "only tasks and bugs");
  assert.equal(validateQuickCreate("TASK", "  ").ok, false);
  assert.equal(validateQuickCreate("TASK", "a\nb").ok, false);
  assert.equal(validateQuickCreate("TASK", "x".repeat(256)).ok, false);

  assert.equal(parseBulkChange("", ""), null, "nothing to change");
  assert.deepEqual(parseBulkChange("high", ""), { priority: "high", assignee: { set: false } });
  assert.deepEqual(parseBulkChange("", "none"), { priority: null, assignee: { set: true, id: null } });
  assert.deepEqual(parseBulkChange("urgent", U.toUpperCase()), { priority: null, assignee: { set: true, id: U } });
  assert.equal(parseBulkChange("", "1 or 1=1"), null);
  assert.equal(formatPoints(null), "0");
  assert.equal(formatPoints(2.5), "2.5");
});

test("reorder events read as sentences", () => {
  const say = (subject, previous) => activity.describeActivity({ action: "WORK_ITEM_REORDERED", subjectName: subject, previousSubjectName: previous, changes: [], workItem: { id: U, issueKey: "BLA-7", title: "x" } });
  assert.equal(say("BLA-3", null), "moved BLA-7 to the top of the backlog, above BLA-3");
  assert.equal(say(null, "BLA-9"), "moved BLA-7 to the bottom of the backlog, below BLA-9");
  assert.equal(say("BLA-4", "BLA-3"), "moved BLA-7 between BLA-3 and BLA-4 in the backlog");
});

test("migration: lock-serialized ranks, unique per project, no status side effects", () => {
  assert.match(migration, /unique \(project_id, backlog_rank\)/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.doesNotMatch(migration.slice(migration.indexOf("create function private.move_backlog_item")), /set status|status =/i);
  assert.match(migration, /before update of type, title, description, parent_id, status/, "reordering does not bump updated_at");
});
