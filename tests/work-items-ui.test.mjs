import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { childProgress, dueState } = await import("../src/features/work-items/presentation.ts");
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const TODAY = "2026-11-28";

test("due dates read from the item's own due date and status", () => {
  assert.equal(dueState(null, "TODO", TODAY), null);
  assert.deepEqual(dueState("2026-11-25", "IN_PROGRESS", TODAY), { label: "Overdue by 3 days", tone: "danger" });
  assert.deepEqual(dueState("2026-11-27", "TODO", TODAY), { label: "Overdue by 1 day", tone: "danger" });
  assert.deepEqual(dueState(TODAY, "BLOCKED", TODAY), { label: "Due today", tone: "warning" });
  assert.deepEqual(dueState("2026-11-29", "TODO", TODAY), { label: "Due tomorrow", tone: "warning" });
  assert.deepEqual(dueState("2026-12-08", "BACKLOG", TODAY), { label: "Due in 10 days", tone: "neutral" });
  assert.equal(dueState("2026-11-01", "DONE", TODAY), null, "finished work is never overdue");
  assert.equal(dueState("2026-11-01", "CANCELLED", TODAY), null);
});

test("child progress ignores archived and cancelled children", () => {
  const progress = childProgress([
    { status: "DONE", archivedAt: null },
    { status: "DONE", archivedAt: null },
    { status: "IN_PROGRESS", archivedAt: null },
    { status: "CANCELLED", archivedAt: null },
    { status: "DONE", archivedAt: "2026-11-01T00:00:00Z" },
  ]);
  assert.deepEqual(progress, { total: 3, done: 2, percent: 66, byStatus: { DONE: 2, IN_PROGRESS: 1 } });
  assert.deepEqual(childProgress([]), { total: 0, done: 0, percent: 0, byStatus: {} });
});

test("the work item page keeps every existing control and puts actions in the header", () => {
  const page = read("../src/app/(dashboard)/projects/[projectId]/work/[workItemId]/page.tsx");
  for (const name of ["StatusControl", "AssigneeControl", "PriorityControl", "HierarchyControl", "WorkItemArchiveControl", "WorkItemContent", "CommentDiscussion", "ActivityFeed", "WorkItemHierarchy"]) {
    assert.match(page, new RegExp(`<${name}\\b`), name);
  }
  assert.match(page, /workItemPermissions\(profile, project, item\)/, "permissions still come from the existing rules");
  assert.match(page, /editableDetails = permissions\.canManage && writable/);
  assert.ok(page.indexOf("<WorkItemHeader") < page.indexOf("<WorkItemContent"), "status actions render before the description");
  assert.ok(page.indexOf("actions={actions}") > 0);
  assert.equal((page.match(/<StatusControl/g) ?? []).length, 1, "one status control");
});

test("work filters stay in the URL; chips are links to existing filter values", () => {
  const filters = read("../src/features/work-items/components/work-filters.tsx");
  assert.match(filters, /method="get" action=\{`\/projects\/\$\{projectId\}\/work`\}/);
  for (const field of ['name="q"', 'name="status"', 'name="priority"', 'name="assignee"', 'name="sort"', 'name="type"', 'name="archived"']) assert.ok(filters.includes(field), field);
  assert.doesNotMatch(filters, /<button(?![^>]*type="submit")/, "the only button submits the form");
  const list = read("../src/features/work-items/components/work-list.tsx");
  assert.doesNotMatch(list, /<button/);
});

test("discussion keeps live updates, mentions and own-comment actions", () => {
  const discussion = read("../src/features/comments/components/comment-discussion.tsx");
  for (const piece of ['"Live"', "Reconnecting", "bodySegments", "onReply", "setEditing(true)", "setConfirming(true)"]) assert.ok(discussion.includes(piece), piece);
  const composer = read("../src/features/comments/components/comment-composer.tsx");
  assert.match(composer, /role="listbox" aria-label="Mention someone"/);
});
