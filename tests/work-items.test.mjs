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

const types = await import("../src/features/work-items/types.ts");
const validation = await import("../src/features/work-items/validation.ts");
const dto = await import("../src/features/work-items/dto.ts");
const activity = await import("../src/features/projects/activity.ts");
const { mapProjectDatabaseError, ProjectError } = await import("../src/features/projects/errors.ts");

const {
  isParentAllowed, childTypesOf, creatableTypes, nextStatuses, workItemPermissions, validateCreateWorkItem,
  validateWorkItemContent, parseWorkItemListQuery, workItemQueryToParams, workItemsHref, parseEstimate, formatEstimate,
} = validation;

const migration = readFileSync(new URL("../supabase/migrations/20261128100000_work_items_foundation.sql", import.meta.url), "utf8");
const ME = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000002";
const PROJECT = "00000000-0000-4000-a000-0000000000aa";

// ---------------------------------------------------------------------------
// Parity with the database
// ---------------------------------------------------------------------------

test("workflow transitions mirror private.work_item_transitions", () => {
  const block = migration.slice(migration.indexOf("insert into private.work_item_transitions"));
  const rows = [...block.slice(0, block.indexOf(";")).matchAll(/\('([A-Z_]+)',\s*'([A-Z_]+)',\s*(true|false)\)/g)]
    .map(([, from, to, managerOnly]) => ({ from, to, managerOnly: managerOnly === "true" }));
  assert.equal(rows.length, 20);
  // Phase 8F2 makes review decisions manager-only.
  const execution = readFileSync(new URL("../supabase/migrations/20261201100000_sprint_execution.sql", import.meta.url), "utf8");
  const tightened = execution.slice(execution.indexOf("update private.work_item_transitions"));
  const pairs = [...tightened.slice(0, tightened.indexOf(";")).matchAll(/\('([A-Z_]+)', '([A-Z_]+)'\)/g)].map(([, from, to]) => `${from}>${to}`);
  assert.deepEqual(pairs, ["IN_REVIEW>DONE", "IN_REVIEW>IN_PROGRESS"]);
  const current = rows.map((row) => (pairs.includes(`${row.from}>${row.to}`) ? { ...row, managerOnly: true } : row));
  assert.deepEqual(current, types.WORK_ITEM_TRANSITIONS);
});

test("hierarchy rules mirror private.work_item_parent_allowed", () => {
  const all = [null, ...types.WORK_ITEM_TYPES];
  const allowed = (child) => all.filter((parent) => isParentAllowed(child, parent));
  assert.deepEqual(allowed("EPIC"), [null]);
  assert.deepEqual(allowed("STORY"), [null, "EPIC"]);
  assert.deepEqual(allowed("TASK"), [null, "STORY"]);
  assert.deepEqual(allowed("SUBTASK"), ["TASK"]);
  assert.deepEqual(allowed("BUG"), [null, "EPIC", "STORY", "TASK"]);
  assert.match(migration, /when 'SUBTASK' then p_parent = 'TASK'/);
  assert.match(migration, /when 'BUG'\s+then p_parent is null or p_parent in \('EPIC', 'STORY', 'TASK'\)/);
  assert.deepEqual(childTypesOf("TASK"), ["SUBTASK", "BUG"]);
  assert.deepEqual(childTypesOf("BUG"), [], "bugs have no children");
});

test("sorts and enums mirror the database", () => {
  for (const sort of types.WORK_ITEM_SORTS) assert.ok(migration.includes(`'${sort}'`), sort);
  assert.match(migration, /create type public\.work_item_type as enum \('EPIC', 'STORY', 'TASK', 'SUBTASK', 'BUG'\)/);
  assert.match(migration, /create type public\.work_item_status as enum \('BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELLED'\)/);
});

// ---------------------------------------------------------------------------
// Workflow and permissions
// ---------------------------------------------------------------------------

test("next statuses depend on the current status, blocked origin and role", () => {
  assert.deepEqual(nextStatuses("BACKLOG", null, false), ["TODO"]);
  assert.deepEqual(nextStatuses("BACKLOG", null, true), ["TODO", "CANCELLED"]);
  assert.deepEqual(nextStatuses("IN_REVIEW", null, false), ["BLOCKED"], "review decisions are manager-only (8F2)");
  assert.deepEqual(nextStatuses("IN_REVIEW", null, true), ["IN_PROGRESS", "DONE", "BLOCKED", "CANCELLED"]);
  assert.deepEqual(nextStatuses("BLOCKED", "IN_REVIEW", false), ["IN_REVIEW"], "blocked returns only to its origin");
  assert.deepEqual(nextStatuses("BLOCKED", "TODO", true), ["TODO", "CANCELLED"]);
  assert.deepEqual(nextStatuses("DONE", null, false), [], "only managers reopen");
  assert.deepEqual(nextStatuses("DONE", null, true), ["IN_PROGRESS"]);
});

test("permissions: managers manage; developers edit and move only their own work", () => {
  const project = { projectManagerId: OTHER, archivedAt: null };
  const item = { assigneeId: ME, status: "TODO", blockedFromStatus: null, archivedAt: null };
  const dev = { id: ME, role: "DEVELOPER" };
  assert.deepEqual(workItemPermissions(dev, project, item), { canManage: false, canEdit: true, canTransition: true, nextStatuses: ["BACKLOG", "IN_PROGRESS", "BLOCKED"] });
  assert.equal(workItemPermissions(dev, project, { ...item, assigneeId: OTHER }).canEdit, false);
  assert.equal(workItemPermissions({ id: OTHER, role: "PROJECT_MANAGER" }, project, { ...item, assigneeId: null }).canManage, true);
  assert.equal(workItemPermissions({ id: ME, role: "PROJECT_MANAGER" }, project, item).canManage, false, "another PM");
  assert.equal(workItemPermissions({ id: ME, role: "SUPER_ADMIN" }, project, item).canManage, true);
  assert.equal(workItemPermissions(dev, project, { ...item, archivedAt: "2026-11-26" }).canEdit, false, "archived item is read-only");
  assert.equal(workItemPermissions({ id: OTHER, role: "PROJECT_MANAGER" }, { ...project, archivedAt: "2026-11-26" }, item).canManage, false, "archived project is read-only");
  assert.deepEqual(creatableTypes(false, "DEVELOPER"), ["TASK", "BUG"]);
  assert.deepEqual(creatableTypes(true, "PROJECT_MANAGER"), ["EPIC", "STORY", "TASK", "SUBTASK", "BUG"]);
  assert.deepEqual(creatableTypes(false, "PROJECT_MANAGER"), []);
});

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

const base = { type: "TASK", title: "  Card form ", status: "BACKLOG", priority: "high", description: "", startDate: "", dueDate: "", estimate: "" };
const developer = { allowedTypes: ["TASK", "BUG"], isManager: false, selfId: ME };
const manager = { allowedTypes: types.WORK_ITEM_TYPES, isManager: true, selfId: OTHER };

test("create form: values are normalized; identity is never taken from the form", () => {
  const result = validateCreateWorkItem({ ...base, assigneeId: ME.toUpperCase(), reporterId: OTHER, estimate: "2.5" }, developer);
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, {
    title: "Card form", description: null, startDate: null, dueDate: null, estimate: 2.5,
    type: "TASK", parentId: null, status: "BACKLOG", priority: "high", assigneeId: ME,
  });
  assert.equal("reporterId" in result.values, false);
});

test("create form: role and type rules", () => {
  assert.ok(validateCreateWorkItem({ ...base, type: "STORY" }, developer).errors.type, "developers cannot create stories");
  assert.ok(validateCreateWorkItem({ ...base, assigneeId: OTHER }, developer).errors.assigneeId, "developers assign only themselves");
  assert.equal(validateCreateWorkItem({ ...base, assigneeId: ME }, manager).ok, true, "managers assign anyone (DB checks membership)");
  assert.ok(validateCreateWorkItem({ ...base, type: "SUBTASK" }, manager).errors.parentId, "subtask needs a parent");
  assert.ok(validateCreateWorkItem({ ...base, type: "EPIC", parentId: PROJECT }, manager).errors.parentId, "epics have no parent");
  assert.ok(validateCreateWorkItem({ ...base, status: "DONE" }, manager).errors.status, "new items start in Backlog/To do");
  assert.ok(validateCreateWorkItem({ ...base, title: "" }, manager).errors.title);
  assert.ok(validateCreateWorkItem({ ...base, title: "a\nb" }, manager).errors.title);
  assert.ok(validateCreateWorkItem({ ...base, title: "x".repeat(256) }, manager).errors.title);
  assert.ok(validateCreateWorkItem({ ...base, startDate: "2027-02-01", dueDate: "2027-01-01" }, manager).errors.dueDate);
});

test("estimates", () => {
  assert.equal(parseEstimate(""), null);
  assert.equal(parseEstimate("3"), 3);
  assert.equal(parseEstimate("0.5"), 0.5);
  for (const bad of ["-1", "1.25", "1001", "abc", "1e3"]) assert.equal(parseEstimate(bad), "invalid", bad);
  assert.equal(formatEstimate(3), "3");
  assert.equal(formatEstimate(2.5), "2.5");
  assert.ok(validateWorkItemContent({ title: "x", estimate: "1.25" }).errors.estimate);
});

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

test("list query: defaults, hostile input and round trip", () => {
  assert.deepEqual(parseWorkItemListQuery({}), {
    search: "", type: null, status: null, priority: null, assignee: { kind: "any" }, archived: false, sort: "updated_desc", page: 1, pageSize: 25,
  });
  const hostile = parseWorkItemListQuery({ type: "STORYX", status: "done", priority: "urgent", assignee: "1 or 1=1", sort: "id;drop", page: "0", size: "1000" });
  assert.deepEqual([hostile.type, hostile.status, hostile.priority, hostile.assignee, hostile.sort, hostile.page, hostile.pageSize],
    [null, null, null, { kind: "any" }, "updated_desc", 1, 25]);
  const query = parseWorkItemListQuery({ q: " cpr-12 ", type: "BUG", status: "IN_REVIEW", priority: "critical", assignee: ME, archived: "1", sort: "key_asc", page: "2", size: "50" });
  assert.deepEqual(parseWorkItemListQuery(Object.fromEntries(workItemQueryToParams(query))), query);
  assert.equal(parseWorkItemListQuery({ assignee: "none" }).assignee.kind, "unassigned");
  assert.equal(workItemsHref(PROJECT, parseWorkItemListQuery({})), `/projects/${PROJECT}/work`);
});

// ---------------------------------------------------------------------------
// DTOs and errors
// ---------------------------------------------------------------------------

const listRow = {
  id: ME, issue_key: "CPR-12", issue_number: 12, type: "TASK", title: "Card form", status: "IN_PROGRESS", priority: "high",
  parent_id: null, parent_issue_key: null, assignee_id: OTHER, assignee_name: "Dev", due_date: null, estimate: 3.5,
  child_count: 2, created_at: "2026-11-26T10:00:00Z", updated_at: "2026-11-26T10:00:00Z", archived_at: null, total_count: 40, extra: "leak",
};

test("list rows parse into DTOs without extra fields", () => {
  const item = dto.toWorkItemListItem(listRow);
  assert.equal(item.issueKey, "CPR-12");
  assert.equal(item.estimate, 3.5);
  assert.equal("extra" in item, false);
  assert.equal(dto.workItemTotal([listRow]), 40);
  assert.throws(() => dto.toWorkItemListItem({ ...listRow, type: "STORYX" }), ProjectError);
  assert.throws(() => dto.toWorkItemListItem({ ...listRow, status: "done" }), ProjectError);
  assert.equal(dto.toWorkItemListItem({ ...listRow, estimate: "2.0" }).estimate, 2, "numeric strings accepted");
});

test("work item errors map to safe codes", () => {
  for (const code of ["invalid_type", "invalid_title", "invalid_parent", "invalid_assignee", "invalid_estimate", "invalid_transition"]) {
    assert.equal(mapProjectDatabaseError({ code: "22023", message: code }), code);
  }
  for (const code of ["work_item_archived", "parent_archived", "has_active_children", "project_archived"]) {
    assert.equal(mapProjectDatabaseError({ code: "55000", message: code }), code);
  }
  assert.equal(mapProjectDatabaseError({ code: "P0002", message: "work_item_not_found" }), "not_found");
  assert.equal(mapProjectDatabaseError({ code: "23503", message: "fk" }), "invalid_parent");
});

// ---------------------------------------------------------------------------
// Activity wording for work item events
// ---------------------------------------------------------------------------

const event = (overrides) => activity.toActivityEntry({
  id: ME, action: "WORK_ITEM_STATUS_CHANGED", created_at: "2026-11-26T10:00:00Z", actor_id: ME, actor_name: "Adil",
  actor_avatar_kind: null, actor_avatar_symbol: null, subject_name: null, previous_subject_name: null, changes: [],
  work_item_id: OTHER, work_item_key: "CPR-12", work_item_title: "Card form", ...overrides,
});

test("work item events read as sentences with readable details", () => {
  const say = (overrides) => activity.describeActivity(event(overrides));
  assert.equal(say({ action: "WORK_ITEM_CREATED" }), "created CPR-12");
  assert.equal(say({ action: "WORK_ITEM_UPDATED", changes: [{ field: "title", from: "A", to: "B" }] }), "renamed CPR-12");
  assert.equal(say({ action: "WORK_ITEM_UPDATED", changes: [{ field: "description" }] }), "updated the description of CPR-12");
  assert.equal(say({ action: "WORK_ITEM_UPDATED", changes: [{ field: "title", from: "A", to: "B" }, { field: "due_date", from: null, to: "2027-01-01" }] }), "updated CPR-12");
  assert.equal(say({ action: "WORK_ITEM_ASSIGNED", subject_name: "Dev Kumar" }), "assigned CPR-12 to Dev Kumar");
  assert.equal(say({ action: "WORK_ITEM_ASSIGNED" }), "unassigned CPR-12");
  assert.equal(say({ action: "WORK_ITEM_PARENT_CHANGED", subject_name: "CPR-3" }), "moved CPR-12 under CPR-3");
  assert.equal(say({ action: "WORK_ITEM_PARENT_CHANGED", subject_name: "CPR-4", previous_subject_name: "CPR-3" }), "moved CPR-12 from CPR-3 to CPR-4");
  assert.equal(say({ action: "WORK_ITEM_PARENT_CHANGED", previous_subject_name: "CPR-3" }), "removed CPR-12 from CPR-3");
  assert.equal(say({ action: "WORK_ITEM_ARCHIVED" }), "archived CPR-12");
  assert.equal(say({ action: "WORK_ITEM_RESTORED" }), "restored CPR-12");

  assert.deepEqual(activity.activityDetails(event({ changes: [{ field: "status", from: "IN_REVIEW", to: "IN_PROGRESS" }] })),
    [{ label: "Status", from: "In review", to: "In progress" }]);
  assert.deepEqual(activity.activityDetails(event({ action: "WORK_ITEM_TYPE_CHANGED", changes: [{ field: "type", from: "BUG", to: "TASK" }] })),
    [{ label: "Type", from: "Bug", to: "Task" }]);
  assert.deepEqual(activity.activityDetails(event({ action: "WORK_ITEM_CREATED", changes: [{ field: "title", to: "Card form" }, { field: "type", to: "TASK" }, { field: "estimate", to: "3.5" }] })),
    [{ label: "Type", from: null, to: "Task" }, { label: "Estimate", from: null, to: "3.5" }]);
  assert.deepEqual(event({}).workItem, { id: OTHER, issueKey: "CPR-12", title: "Card form" });
  assert.equal(event({ work_item_id: null }).workItem, null);
});
