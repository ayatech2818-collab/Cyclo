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

const reviews = await import("../src/features/reviews/logic.ts");
const execution = await import("../src/features/work-items/execution.ts");
const { ProjectError } = await import("../src/features/projects/errors.ts");

const {
  canUseReviewInbox, parseReviewQuery, reviewQueryToParams, reviewsHref, reviewQueueArgs, hasActiveReviewFilters,
  toReviewItem, toReviewPage, toReviewSummary, removeFromSummary, formatWaiting, waitingTone, formatSubmittedAt,
  REVIEW_SORTS, REVIEW_AGES, REVIEW_PAGE_SIZE, DEFAULT_REVIEW_QUERY,
} = reviews;

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../supabase/migrations/20261202100000_review_inbox.sql");
const actions = read("../src/features/reviews/actions.ts");
const layout = read("../src/app/(dashboard)/reviews/layout.tsx");
const queries = read("../src/features/reviews/queries.server.ts");

const P1 = "00000000-0000-4000-a000-0000000000a1";
const P2 = "00000000-0000-4000-a000-0000000000a2";
const DEV = "00000000-0000-4000-a000-000000000001";
const ITEM = "00000000-0000-4000-a000-0000000000f1";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-12-02T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

test("only Super Admins and Project Managers use the inbox (three roles unchanged)", () => {
  assert.equal(canUseReviewInbox("SUPER_ADMIN"), true);
  assert.equal(canUseReviewInbox("PROJECT_MANAGER"), true);
  assert.equal(canUseReviewInbox("DEVELOPER"), false);
  assert.match(layout, /if \(!canUseReviewInbox\(profile\.role\)\) notFound\(\)/, "the route 404s for developers");
  assert.match(queries, /if \(!canUseReviewInbox\(profile\.role\)\) throw new ProjectError\("forbidden"\)/, "reads fail fast");
  assert.match(actions, /if \(!canUseReviewInbox\(profile\.role\)\) return failure\(new ProjectError\("forbidden"\)\)/, "the action re-checks the role");
});

test("the database decides scope and refuses developers", () => {
  const actor = migration.slice(migration.indexOf("create function private.review_actor"), migration.indexOf("create function private.list_review_queue"));
  assert.match(actor, /not in \('SUPER_ADMIN'::public\.app_role, 'PROJECT_MANAGER'::public\.app_role\)/);
  assert.match(actor, /errcode = '42501', message = 'forbidden'/);
  for (const name of ["private.list_review_queue(", "private.review_queue_summary("]) {
    const body = migration.slice(migration.indexOf(`create function ${name}`));
    const scoped = body.slice(0, body.indexOf("$$;"));
    assert.match(scoped, /security definer/);
    assert.match(scoped, /select \* into v_actor from private\.review_actor\(\)/, `${name} checks the caller first`);
    assert.match(scoped, /w\.status = 'IN_REVIEW'/, `${name} returns IN_REVIEW only`);
    assert.match(scoped, /\(v_actor\.is_super_admin or pr\.project_manager_id = v_actor\.actor_id\)/, `${name} scopes PMs to assigned projects`);
    assert.match(scoped, /w\.archived_at is null[\s\S]*pr\.archived_at is null/, `${name} skips archived work and projects`);
    assert.doesNotMatch(scoped, /\.email/, `${name} never returns emails`);
  }
  assert.match(migration, /revoke all on function private\.review_actor\(\) from public, anon, authenticated, service_role;/);
  assert.doesNotMatch(migration, /grant execute on function private\.review_actor\(\)/, "the helper is not callable directly");
  assert.doesNotMatch(migration, /create table/i, "no new tables");
});

test("decisions reuse execute_work_item with the IN_REVIEW guard; the client sends no project, role or user", () => {
  assert.match(actions, /client\.rpc\("execute_work_item", \{\s*p_work_item_id: workItemId, p_action: decision, p_expected_status: "IN_REVIEW"/);
  assert.match(actions, /decision !== "approve" && decision !== "reject"/);
  const signature = actions.slice(actions.indexOf("export async function decideReviewAction"), actions.indexOf("Promise<ReviewDecisionResult>"));
  assert.doesNotMatch(signature, /projectId|role|userId|profileId/);
  assert.match(actions, /decision === "reject" && reason === null\) return failure\(new ProjectError\("reason_required"\)\)/);
});

test("review moves come from the 8F2 execution definitions", () => {
  assert.equal(execution.REVIEW_MOVES.approve.action, "approve");
  assert.equal(execution.REVIEW_MOVES.approve.to, "DONE");
  assert.ok(execution.REVIEW_MOVES.approve.confirm, "approval asks for confirmation");
  assert.equal(execution.REVIEW_MOVES.reject.action, "reject");
  assert.equal(execution.REVIEW_MOVES.reject.to, "IN_PROGRESS");
  assert.equal(execution.REVIEW_MOVES.reject.needsReason, true);
  assert.equal(execution.executionActionFor("IN_REVIEW", "DONE", null), "approve");
  assert.equal(execution.executionActionFor("IN_REVIEW", "IN_PROGRESS", null), "reject");
});

// ---------------------------------------------------------------------------
// Query parsing (parity with the database)
// ---------------------------------------------------------------------------

test("sorts, ages and page size stay within what the database accepts", () => {
  const sorts = migration.match(/p_sort not in \(([^)]+)\)/)[1].match(/'([a-z]+)'/g).map((value) => value.slice(1, -1));
  assert.deepEqual([...REVIEW_SORTS], sorts);
  assert.ok(REVIEW_AGES.every((age) => age >= 0 && age <= 365));
  assert.ok(REVIEW_PAGE_SIZE >= 1 && REVIEW_PAGE_SIZE <= 100);
  assert.match(migration, /p_sort text default 'oldest'/, "oldest first by default");
});

test("query: defaults, hostile input and round trip", () => {
  assert.deepEqual(parseReviewQuery({}), DEFAULT_REVIEW_QUERY);
  const hostile = parseReviewQuery({ q: "  a\u0000b  ", project: "1; drop", assignee: "admin", priority: "urgent", age: "2", sort: "updated", page: "-4" });
  assert.deepEqual(hostile, { ...DEFAULT_REVIEW_QUERY, search: "a b" });
  assert.equal(parseReviewQuery({ page: "9999999" }).page, 1, "out-of-range page falls back");
  assert.equal(parseReviewQuery({ q: "x".repeat(500) }).search.length <= 100, true, "search is bounded");
  assert.equal(parseReviewQuery({ project: [P1, P2] }).projectId, null, "repeated params are ignored");

  const query = parseReviewQuery({ q: "cpr-12", project: P1.toUpperCase(), assignee: DEV, priority: "high", age: "3", sort: "priority", page: "2" });
  assert.deepEqual(query, { search: "cpr-12", projectId: P1, assignee: { kind: "person", id: DEV }, priority: "high", minAgeDays: 3, sort: "priority", page: 2 });
  assert.deepEqual(parseReviewQuery(Object.fromEntries(reviewQueryToParams(query))), query);
  assert.equal(reviewsHref(DEFAULT_REVIEW_QUERY), "/reviews");
  assert.equal(reviewsHref(query, { page: 1 }), `/reviews?q=cpr-12&project=${P1}&assignee=${DEV}&priority=high&age=3&sort=priority`);
  assert.equal(parseReviewQuery({ assignee: "none" }).assignee.kind, "unassigned");
  assert.equal(hasActiveReviewFilters(DEFAULT_REVIEW_QUERY), false);
  assert.equal(hasActiveReviewFilters({ ...DEFAULT_REVIEW_QUERY, minAgeDays: 1 }), true);
});

test("query maps to RPC arguments", () => {
  assert.deepEqual(reviewQueueArgs(DEFAULT_REVIEW_QUERY), {
    p_search: undefined, p_project_id: undefined, p_assignee_id: undefined, p_unassigned: false,
    p_priority: undefined, p_min_age_days: undefined, p_sort: "oldest", p_page: 1, p_page_size: REVIEW_PAGE_SIZE,
  });
  const args = reviewQueueArgs({ ...DEFAULT_REVIEW_QUERY, assignee: { kind: "unassigned" }, minAgeDays: 7, page: 3 });
  assert.equal(args.p_unassigned, true);
  assert.equal(args.p_assignee_id, undefined, "never both");
  assert.equal(args.p_min_age_days, 7);
  assert.equal(args.p_page, 3);
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const row = (overrides = {}) => ({
  id: ITEM, issue_key: "CPR-12", issue_number: 12, type: "TASK", title: "Checkout", priority: "high",
  project_id: P1, project_name: "Checkout", project_key: "CPR", assignee_id: DEV, assignee_name: " Dev Kumar ",
  submitted_at: ago(2 * DAY), total_count: 41, email: "leak@example.com", ...overrides,
});

test("rows parse into DTOs without extra fields", () => {
  const item = toReviewItem(row());
  assert.deepEqual(Object.keys(item).sort(), ["assigneeId", "assigneeName", "id", "issueKey", "priority", "projectId", "projectKey", "projectName", "submittedAt", "title", "type"]);
  assert.equal(item.assigneeName, "Dev Kumar");
  assert.equal(toReviewItem(row({ assignee_id: null, assignee_name: null })).assigneeId, null);
  assert.equal(toReviewItem(row({ assignee_name: "  " })).assigneeName, null, "blank names read as unnamed");
  for (const bad of [row({ type: "SPIKE" }), row({ priority: "urgent" }), row({ submitted_at: "yesterday" }), row({ id: null }), null, []]) {
    assert.throws(() => toReviewItem(bad), ProjectError);
  }
  const page = toReviewPage([row(), row({ id: P2 })], 2, NOW);
  assert.deepEqual([page.total, page.page, page.pageCount, page.asOf, page.items.length], [41, 2, Math.ceil(41 / REVIEW_PAGE_SIZE), NOW, 2]);
  assert.deepEqual(toReviewPage([], 3, NOW, 5), { items: [], total: 5, page: 3, pageCount: 1, asOf: NOW });
  assert.throws(() => toReviewPage([row({ total_count: -1 })], 1, NOW), ProjectError);
});

test("summary totals and removal keep counts consistent", () => {
  const summary = toReviewSummary([
    { scope: "project", id: P1, label: "Checkout", project_key: "CPR", pending_count: 3, oldest_submitted_at: ago(5 * DAY) },
    { scope: "project", id: P2, label: "Mobile", project_key: "MOB", pending_count: 1, oldest_submitted_at: ago(DAY) },
    { scope: "assignee", id: DEV, label: "Dev Kumar", project_key: null, pending_count: 3, oldest_submitted_at: ago(5 * DAY) },
    { scope: "assignee", id: null, label: null, project_key: null, pending_count: 1, oldest_submitted_at: ago(DAY) },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.oldestSubmittedAt, ago(5 * DAY));
  assert.deepEqual(summary.projects.map((facet) => facet.id), [P1, P2]);
  assert.equal(summary.assignees.length, 2);

  const once = removeFromSummary(summary, { projectId: P2, assigneeId: null });
  assert.equal(once.total, 3);
  assert.deepEqual(once.projects.map((facet) => facet.id), [P1], "empty projects drop out");
  assert.deepEqual(once.assignees.map((facet) => facet.id), [DEV]);
  assert.equal(removeFromSummary(once, { projectId: P1, assigneeId: DEV }).projects[0].count, 2);
  assert.equal(removeFromSummary({ ...summary, total: 0, projects: [], assignees: [] }, { projectId: P1, assigneeId: DEV }).total, 0, "never negative");

  assert.deepEqual(toReviewSummary([]), { total: 0, oldestSubmittedAt: null, projects: [], assignees: [] });
  assert.throws(() => toReviewSummary([{ scope: "sprint", id: P1, label: "x", project_key: null, pending_count: 1, oldest_submitted_at: ago(1) }]), ProjectError);
  assert.throws(() => toReviewSummary([{ scope: "project", id: null, label: "x", project_key: null, pending_count: 1, oldest_submitted_at: ago(1) }]), ProjectError);
});

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

test("waiting time reads naturally and flags old reviews", () => {
  assert.equal(formatWaiting(ago(10_000), NOW), "just now");
  assert.equal(formatWaiting(ago(-60_000), NOW), "just now", "clock skew is not negative time");
  assert.equal(formatWaiting(ago(12 * 60_000), NOW), "12m");
  assert.equal(formatWaiting(ago(5 * HOUR), NOW), "5h");
  assert.equal(formatWaiting(ago(2 * DAY + 3 * HOUR), NOW), "2d 3h");
  assert.equal(formatWaiting(ago(2 * DAY), NOW), "2d");
  assert.equal(formatWaiting(ago(14 * DAY + 5 * HOUR), NOW), "14d");
  assert.equal(waitingTone(ago(5 * HOUR), NOW), "fresh");
  assert.equal(waitingTone(ago(DAY), NOW), "aging");
  assert.equal(waitingTone(ago(3 * DAY), NOW), "overdue");
  assert.equal(formatSubmittedAt("2026-12-01T09:05:00Z"), "1 Dec 2026, 09:05 UTC");
  assert.equal(formatSubmittedAt("not a date"), "");
});
