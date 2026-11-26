// Integration check of sprint execution (Phase 8F2) through the REAL local
// Supabase HTTP stack: developer workflow, review, concurrency, board,
// progress/burndown consistency and audit. LOCAL ONLY.
//
//   node --env-file=.env.supabase-local --test tests/integration/sprint-execution.local.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { localSql } from "../helpers/local-postgres.mjs";
import { createFixtures, runId } from "../helpers/project-fixtures.mjs";

const run = runId();
const { users, makeUser, cleanup } = createFixtures(`exec-${run}`);
const ids = {};
const isoDay = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  await makeUser("pm1", "PROJECT_MANAGER");
  await makeUser("dev1", "DEVELOPER");
  await makeUser("dev2", "DEVELOPER");
  await makeUser("outsider", "DEVELOPER");
  const project = await users.pm1.client.rpc("create_project", { p_name: `Execution ${run}`, p_project_key: `X${run}`, p_priority: "medium" });
  if (project.error) throw project.error;
  ids.project = project.data;
  for (const name of ["dev1", "dev2"]) await users.pm1.client.rpc("add_project_member", { p_project_id: ids.project, p_profile_id: users[name].id });
  const create = async (title, assignee, estimate) => {
    const { data, error } = await users.pm1.client.rpc("create_work_item", {
      p_project_id: ids.project, p_type: "TASK", p_title: title, p_status: "TODO", p_estimate: estimate ?? undefined, p_assignee_id: users[assignee].id,
    });
    if (error) throw error;
    return data;
  };
  ids.a = await create("Alpha", "dev1", 3);
  ids.b = await create("Bravo", "dev1", 5);
  ids.c = await create("Charlie", "dev2", 2);
  ids.d = await create("Delta", "dev1", null);
  const sprint = await users.pm1.client.rpc("create_sprint", { p_project_id: ids.project, p_name: "Run", p_start_date: isoDay(-2), p_end_date: isoDay(10) });
  if (sprint.error) throw sprint.error;
  ids.sprint = sprint.data;
  const planned = await users.pm1.client.rpc("create_sprint", { p_project_id: ids.project, p_name: "Next", p_start_date: isoDay(11), p_end_date: isoDay(20) });
  ids.planned = planned.data;
  const added = await users.pm1.client.rpc("add_work_items_to_sprint", { p_sprint_id: ids.sprint, p_work_item_ids: [ids.a, ids.b, ids.c, ids.d] });
  if (added.error) throw added.error;
  const started = await users.pm1.client.rpc("start_sprint", { p_sprint_id: ids.sprint });
  if (started.error) throw started.error;
});

after(cleanup);

const execute = (user, id, action, expected, reason) =>
  users[user].client.rpc("execute_work_item", { p_work_item_id: id, p_action: action, p_expected_status: expected, p_reason: reason });
const statusOf = async (id) => (await users.pm1.client.rpc("get_work_item", { p_work_item_id: id })).data[0].status;

test("the board lists the sprint's open work for members only", async () => {
  const board = await users.dev2.client.rpc("list_sprint_board", { p_sprint_id: ids.sprint });
  assert.equal(board.error, null);
  assert.deepEqual(board.data.map((row) => row.id).sort(), [ids.a, ids.b, ids.c, ids.d].sort());
  const outsider = await users.outsider.client.rpc("list_sprint_board", { p_sprint_id: ids.sprint });
  assert.ok(outsider.error, "non-members cannot read the board");
});

test("developers act only on their own items and cannot decide reviews", async () => {
  assert.equal((await execute("dev1", ids.c, "start", "TODO")).error?.message, "forbidden", "dev2's item");
  assert.equal((await execute("outsider", ids.a, "start", "TODO")).error?.code, "P0002");
  assert.equal((await execute("dev1", ids.a, "finish", "TODO")).error?.message, "invalid_action");
  assert.equal((await execute("dev1", ids.a, "submit_review", "TODO")).error?.message, "invalid_transition");
  assert.equal((await users.dev1.client.rpc("change_work_item_status", { p_work_item_id: ids.d, p_status: "BLOCKED" })).error?.message, "blocked_reason_required");
});

test("parallel duplicate starts: one change, one no-op, one audit event", async () => {
  const results = await Promise.all([execute("dev1", ids.a, "start", "TODO"), execute("dev1", ids.a, "start", "TODO")]);
  assert.ok(results.every((result) => !result.error), JSON.stringify(results.map((result) => result.error)));
  assert.deepEqual(results.map((result) => result.data[0].changed).sort(), [false, true]);
  assert.equal(await statusOf(ids.a), "IN_PROGRESS");
  const audit = localSql(`select count(*) from private.project_audit_log where work_item_id = '${ids.a}' and action = 'WORK_ITEM_STARTED';`);
  assert.equal(audit.stdout.trim(), "1");
});

test("conflicting moves: exactly one wins, the other sees status_changed", async () => {
  const results = await Promise.all([execute("dev1", ids.b, "start", "TODO"), execute("dev1", ids.b, "block", "TODO", "Waiting for design")]);
  const won = results.filter((result) => !result.error);
  const lost = results.filter((result) => result.error);
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].error.code, "55000");
  assert.equal(lost[0].error.message, "status_changed");
  const status = await statusOf(ids.b);
  assert.ok(status === "IN_PROGRESS" || status === "BLOCKED", status);
  if (status === "BLOCKED") {
    const resumed = await execute("dev1", ids.b, "resume", "BLOCKED");
    assert.equal(resumed.data[0].status, "TODO", "resume returns to the status it was blocked from");
    assert.equal((await execute("dev1", ids.b, "start", "TODO")).error, null);
  }
});

test("block needs a reason, resume returns to the previous status", async () => {
  assert.equal((await execute("dev1", ids.b, "block", "IN_PROGRESS", "  ")).error?.message, "reason_required");
  const blocked = await execute("dev1", ids.b, "block", "IN_PROGRESS", "Waiting for API keys");
  assert.equal(blocked.error, null);
  assert.deepEqual([blocked.data[0].status, blocked.data[0].blocked_from_status, blocked.data[0].blocked_reason], ["BLOCKED", "IN_PROGRESS", "Waiting for API keys"]);
  const context = await users.dev2.client.rpc("work_item_execution", { p_work_item_id: ids.b });
  assert.equal(context.data[0].blocked_reason, "Waiting for API keys");
  assert.equal(context.data[0].sprint_status, "ACTIVE");
  const resumed = await execute("dev1", ids.b, "resume", "BLOCKED");
  assert.deepEqual([resumed.data[0].status, resumed.data[0].blocked_reason], ["IN_PROGRESS", null]);
});

test("submit is never Done; the PM approves or requests changes", async () => {
  const submitted = await execute("dev1", ids.a, "submit_review", "IN_PROGRESS");
  assert.equal(submitted.data[0].status, "IN_REVIEW");
  assert.equal((await execute("dev1", ids.a, "approve", "IN_REVIEW")).error?.message, "forbidden");
  assert.equal((await users.dev1.client.rpc("change_work_item_status", { p_work_item_id: ids.a, p_status: "DONE" })).error?.message, "forbidden");
  assert.equal((await execute("pm1", ids.a, "reject", "IN_REVIEW")).error?.message, "reason_required");
  const rejected = await execute("pm1", ids.a, "reject", "IN_REVIEW", "Add input validation");
  assert.equal(rejected.data[0].status, "IN_PROGRESS");
  await execute("dev1", ids.a, "submit_review", "IN_PROGRESS");
  const approved = await execute("pm1", ids.a, "approve", "IN_REVIEW");
  assert.equal(approved.data[0].status, "DONE");
  const retry = await execute("pm1", ids.a, "approve", "IN_REVIEW");
  assert.equal(retry.data[0].changed, false, "a retried approval is a no-op");
  const context = await users.dev1.client.rpc("work_item_execution", { p_work_item_id: ids.a });
  assert.equal(context.data[0].last_review_action, "WORK_ITEM_REVIEW_APPROVED");
});

test("cancelled work leaves the board and never counts as completed", async () => {
  const cancelled = await users.pm1.client.rpc("change_work_item_status", { p_work_item_id: ids.d, p_status: "CANCELLED" });
  assert.equal(cancelled.error, null);
  const board = await users.dev1.client.rpc("list_sprint_board", { p_sprint_id: ids.sprint });
  assert.ok(!board.data.some((row) => row.id === ids.d));
  const { data } = await users.dev1.client.rpc("sprint_progress", { p_sprint_id: ids.sprint });
  const total = data.find((row) => row.scope === "total");
  // a DONE (3), b IN_PROGRESS (5), c TODO (2); d cancelled.
  assert.deepEqual(
    [total.total_items, total.completed_items, total.remaining_items, total.cancelled_items, Number(total.total_points), Number(total.completed_points), Number(total.remaining_points), total.completion_percent],
    [3, 1, 2, 1, 10, 3, 7, 30],
  );
  // The board and the progress agree.
  const points = board.data.reduce((sum, row) => sum + Number(row.estimate ?? 0), 0);
  assert.equal(points, Number(total.total_points));
  const dev1 = data.find((row) => row.scope === "assignee" && row.assignee_id === users.dev1.id);
  assert.deepEqual([dev1.total_items, dev1.completed_items, Number(dev1.completed_points)], [2, 1, 3]);
});

test("burndown is database history: gaps before the baseline, today matches progress", async () => {
  const { data, error } = await users.dev2.client.rpc("sprint_burndown", { p_sprint_id: ids.sprint });
  assert.equal(error, null);
  assert.equal(data[0].day, isoDay(-2));
  assert.equal(data.at(-1).day, isoDay(0));
  assert.equal(data[0].has_data, false, "the sprint started today: earlier days have no history");
  assert.equal(data[0].remaining_points, null, "missing history is NULL, not zero");
  const today = data.at(-1);
  assert.equal(today.has_data, true);
  const progress = (await users.dev2.client.rpc("sprint_progress", { p_sprint_id: ids.sprint })).data.find((row) => row.scope === "total");
  assert.equal(Number(today.remaining_points), Number(progress.remaining_points));
  assert.equal(Number(today.completed_points), Number(progress.completed_points));
  const planned = await users.dev2.client.rpc("sprint_burndown", { p_sprint_id: ids.planned });
  assert.deepEqual(planned.data, [], "no burndown before a sprint starts");
});

test("execution events are audited once each, with reasons", async () => {
  const rows = localSql(`select action || '|' || coalesce(new_values ->> 'reason', '') from private.project_audit_log
    where project_id = '${ids.project}' and action like 'WORK_ITEM_%' and action not in ('WORK_ITEM_CREATED', 'WORK_ITEM_ADDED_TO_SPRINT') order by created_at, id;`);
  const events = rows.stdout.trim().split("\n");
  assert.ok(events.includes("WORK_ITEM_BLOCKED|Waiting for API keys"), events.join(", "));
  assert.ok(events.includes("WORK_ITEM_REVIEW_REJECTED|Add input validation"));
  assert.equal(events.filter((event) => event.startsWith("WORK_ITEM_REVIEW_APPROVED")).length, 1, "the retried approval added nothing");
  assert.ok(events.includes("WORK_ITEM_SUBMITTED_FOR_REVIEW|"));
  assert.ok(events.includes("WORK_ITEM_RESUMED|"));
  const feed = await users.dev1.client.rpc("list_project_activity", { p_project_id: ids.project, p_work_item_id: ids.a });
  assert.ok(feed.data.some((row) => row.action === "WORK_ITEM_REVIEW_REJECTED" && JSON.stringify(row.changes).includes("Add input validation")));
});

test("history survives: a completed sprint keeps its burndown and board is read-only by status", async () => {
  const completed = await users.pm1.client.rpc("complete_sprint", { p_sprint_id: ids.sprint, p_carry_over: "backlog" });
  assert.equal(completed.error, null);
  const { data } = await users.dev1.client.rpc("sprint_burndown", { p_sprint_id: ids.sprint });
  assert.equal(data.at(-1).has_data, true);
  const { data: sprint } = await users.dev1.client.rpc("get_sprint", { p_sprint_id: ids.sprint });
  assert.equal(sprint[0].status, "COMPLETED");
});
