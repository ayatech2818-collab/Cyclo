// Integration check of the Review Inbox (Phase 8G1) through the REAL local
// Supabase HTTP stack: scope per role, filters/pagination, decisions through
// execute_work_item, duplicate and concurrent decisions. LOCAL ONLY.
//
//   node --env-file=.env.supabase-local --test tests/integration/review-inbox.local.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { localSql } from "../helpers/local-postgres.mjs";
import { createFixtures, runId } from "../helpers/project-fixtures.mjs";

const run = runId();
const { users, makeUser, cleanup } = createFixtures(`review-${run}`);
const ids = {};

const execute = (user, id, action, reason) =>
  users[user].client.rpc("execute_work_item", { p_work_item_id: id, p_action: action, p_expected_status: "IN_REVIEW", p_reason: reason });
const queue = (user, args = {}) => users[user].client.rpc("list_review_queue", { p_page_size: 100, ...args });
const mine = (rows) => rows.filter((row) => row.project_id === ids.p1 || row.project_id === ids.p2);
const statusOf = async (id) => (await users.pm1.client.rpc("get_work_item", { p_work_item_id: id })).data[0].status;

async function inReview(manager, project, title, assignee, priority = "medium") {
  const created = await users[manager].client.rpc("create_work_item", {
    p_project_id: project, p_type: "TASK", p_title: title, p_status: "TODO", p_priority: priority, p_assignee_id: users[assignee].id,
  });
  if (created.error) throw created.error;
  for (const [action, expected] of [["start", "TODO"], ["submit_review", "IN_PROGRESS"]]) {
    const step = await users[assignee].client.rpc("execute_work_item", { p_work_item_id: created.data, p_action: action, p_expected_status: expected });
    if (step.error) throw step.error;
  }
  return created.data;
}

before(async () => {
  await makeUser("sa", "SUPER_ADMIN");
  await makeUser("pm1", "PROJECT_MANAGER");
  await makeUser("pm2", "PROJECT_MANAGER");
  await makeUser("dev1", "DEVELOPER");
  await makeUser("dev2", "DEVELOPER");
  for (const [pm, key, dev] of [["pm1", "p1", "dev1"], ["pm2", "p2", "dev2"]]) {
    const project = await users[pm].client.rpc("create_project", { p_name: `Reviews ${key} ${run}`, p_project_key: `R${key.toUpperCase()}${run}`.slice(0, 10), p_priority: "medium" });
    if (project.error) throw project.error;
    ids[key] = project.data;
    const member = await users[pm].client.rpc("add_project_member", { p_project_id: ids[key], p_profile_id: users[dev].id });
    if (member.error) throw member.error;
  }
  ids.a = await inReview("pm1", ids.p1, "Alpha review", "dev1", "high");
  ids.b = await inReview("pm1", ids.p1, "Bravo review", "dev1");
  ids.c = await inReview("pm1", ids.p1, "Charlie review", "dev1", "low");
  ids.d = await inReview("pm1", ids.p1, "Delta review", "dev1");
  ids.g = await inReview("pm2", ids.p2, "Golf review", "dev2", "critical");
  // Oldest first needs distinct submission times: A oldest, then B, C, D.
  const ages = { a: "4 days", b: "3 days", c: "2 days", d: "1 hour" };
  for (const [key, age] of Object.entries(ages)) {
    const result = localSql(`update private.project_audit_log set created_at = now() - interval '${age}'
      where work_item_id = '${ids[key]}' and action = 'WORK_ITEM_SUBMITTED_FOR_REVIEW';`);
    assert.equal(result.code, 0, result.stderr);
  }
});

after(cleanup);

test("developers cannot read the inbox over HTTP", async () => {
  const list = await queue("dev1");
  assert.equal(list.error?.code, "42501");
  assert.equal(list.error?.message, "forbidden");
  const summary = await users.dev1.client.rpc("review_queue_summary");
  assert.equal(summary.error?.message, "forbidden");
});

test("the Super Admin sees reviews across projects; each PM only their own", async () => {
  const sa = await queue("sa");
  assert.equal(sa.error, null);
  assert.deepEqual(mine(sa.data).map((row) => row.id), [ids.a, ids.b, ids.c, ids.d, ids.g], "oldest first across projects (G was submitted just now)");

  const pm1 = await queue("pm1");
  assert.deepEqual(pm1.data.map((row) => row.id), [ids.a, ids.b, ids.c, ids.d]);
  assert.ok(pm1.data.every((row) => row.project_id === ids.p1), "no other project's rows");
  const pm2 = await queue("pm2");
  assert.deepEqual(pm2.data.map((row) => row.id), [ids.g]);

  const leak = await queue("pm2", { p_project_id: ids.p1 });
  assert.deepEqual(leak.data, [], "a foreign project id returns nothing");
  const summary = await users.pm2.client.rpc("review_queue_summary");
  assert.deepEqual(summary.data.filter((row) => row.scope === "project").map((row) => [row.id, row.pending_count]), [[ids.p2, 1]]);
});

test("rows expose names only, never emails or other profile fields", async () => {
  const { data } = await queue("pm1");
  assert.deepEqual(Object.keys(data[0]).sort(), [
    "assignee_id", "assignee_name", "id", "issue_key", "issue_number", "priority", "project_id", "project_key", "project_name", "submitted_at", "title", "total_count", "type",
  ]);
  assert.match(data[0].assignee_name, /^IT dev1 /);
  assert.ok(!JSON.stringify(data).includes("@cyclo.test"));
});

test("pagination is stable and filters narrow the queue", async () => {
  const first = await queue("pm1", { p_page: 1, p_page_size: 3 });
  const second = await queue("pm1", { p_page: 2, p_page_size: 3 });
  assert.deepEqual([...first.data, ...second.data].map((row) => row.id), [ids.a, ids.b, ids.c, ids.d]);
  assert.equal(Number(second.data[0].total_count), 4);
  assert.deepEqual((await queue("pm1", { p_priority: "high" })).data.map((row) => row.id), [ids.a]);
  assert.deepEqual((await queue("pm1", { p_min_age_days: 3 })).data.map((row) => row.id), [ids.a, ids.b]);
  assert.deepEqual((await queue("pm1", { p_search: "charlie" })).data.map((row) => row.id), [ids.c]);
  assert.deepEqual((await queue("pm1", { p_assignee_id: users.dev2.id })).data, []);
  assert.equal((await queue("pm1", { p_page_size: 500 })).error?.message, "invalid_page_size");
});

test("approve and request changes go through execute_work_item", async () => {
  assert.equal((await execute("dev1", ids.a, "approve")).error?.message, "forbidden", "assignees cannot approve");
  assert.equal((await execute("pm2", ids.a, "approve")).error?.code, "P0002", "another project's PM cannot see it");
  const approved = await execute("pm1", ids.a, "approve");
  assert.equal(approved.error, null);
  assert.deepEqual([approved.data[0].status, approved.data[0].changed], ["DONE", true]);

  assert.equal((await execute("pm1", ids.b, "reject")).error?.message, "reason_required");
  const rejected = await execute("sa", ids.b, "reject", "Cover the empty-cart case");
  assert.deepEqual([rejected.data[0].status, rejected.data[0].changed], ["IN_PROGRESS", true]);
  const audit = localSql(`select new_values ->> 'reason' from private.project_audit_log where work_item_id = '${ids.b}' and action = 'WORK_ITEM_REVIEW_REJECTED';`);
  assert.equal(audit.stdout.trim(), "Cover the empty-cart case");

  const after = await queue("pm1");
  assert.deepEqual(after.data.map((row) => row.id), [ids.c, ids.d], "decided items leave the queue");
});

test("duplicate approvals: one change, one no-op, one audit event", async () => {
  const results = await Promise.all([execute("pm1", ids.c, "approve"), execute("sa", ids.c, "approve")]);
  assert.ok(results.every((result) => !result.error), JSON.stringify(results.map((result) => result.error)));
  assert.deepEqual(results.map((result) => result.data[0].changed).sort(), [false, true]);
  assert.equal(await statusOf(ids.c), "DONE");
  const events = localSql(`select count(*) from private.project_audit_log where work_item_id = '${ids.c}' and action = 'WORK_ITEM_REVIEW_APPROVED';`);
  assert.equal(events.stdout.trim(), "1");
});

test("conflicting decisions: exactly one wins, the other is refused as stale", async () => {
  const results = await Promise.all([execute("pm1", ids.d, "approve"), execute("sa", ids.d, "reject", "Needs one more test")]);
  const won = results.filter((result) => !result.error);
  const lost = results.filter((result) => result.error);
  assert.equal(won.length, 1, JSON.stringify(results.map((result) => result.error)));
  assert.equal(lost.length, 1);
  assert.equal(lost[0].error.code, "55000");
  assert.equal(lost[0].error.message, "status_changed");
  const status = await statusOf(ids.d);
  assert.equal(status, won[0].data[0].status);
  assert.ok(status === "DONE" || status === "IN_PROGRESS", status);
  const decisions = localSql(`select count(*) from private.project_audit_log where work_item_id = '${ids.d}' and action in ('WORK_ITEM_REVIEW_APPROVED', 'WORK_ITEM_REVIEW_REJECTED');`);
  assert.equal(decisions.stdout.trim(), "1");
  assert.deepEqual((await queue("pm1")).data, [], "project one's queue is empty");
});
