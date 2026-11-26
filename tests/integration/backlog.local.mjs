// Integration check of backlog ordering and planning (Phase 8E) through the
// REAL local Supabase HTTP stack. Concurrent requests run in parallel. LOCAL ONLY.
//
//   node --env-file=.env.supabase-local --test tests/integration/backlog.local.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createFixtures, runId } from "../helpers/project-fixtures.mjs";

const run = runId();
const { users, makeUser, cleanup } = createFixtures(`backlog-${run}`);
const ids = { items: [] };

before(async () => {
  await makeUser("pm1", "PROJECT_MANAGER");
  await makeUser("pm2", "PROJECT_MANAGER");
  await makeUser("dev1", "DEVELOPER");
  await makeUser("dev2", "DEVELOPER");
  const project = await users.pm1.client.rpc("create_project", { p_name: `Backlog ${run}`, p_project_key: `B${run}`, p_priority: "medium" });
  if (project.error) throw project.error;
  ids.project = project.data;
  const member = await users.pm1.client.rpc("add_project_member", { p_project_id: ids.project, p_profile_id: users.dev1.id });
  if (member.error) throw member.error;
  ids.epic = (await users.pm1.client.rpc("create_work_item", { p_project_id: ids.project, p_type: "EPIC", p_title: "Epic" })).data;
  for (let index = 0; index < 20; index += 1) {
    const { data, error } = await users.pm1.client.rpc("create_work_item", { p_project_id: ids.project, p_type: index % 4 === 0 ? "BUG" : "TASK", p_title: `Item ${index}` });
    if (error) throw error;
    ids.items.push(data);
  }
});

after(cleanup);

const backlog = async (who = "pm1", args = {}) => {
  const { data, error } = await users[who].client.rpc("list_backlog", { p_project_id: ids.project, p_page_size: 100, ...args });
  assert.equal(error, null);
  return data;
};
const move = (who, id, afterId, beforeId) =>
  users[who].client.rpc("move_backlog_item", { p_work_item_id: id, p_after_id: afterId ?? undefined, p_before_id: beforeId ?? undefined });

function assertConsistent(rows, expectedCount) {
  assert.equal(rows.length, expectedCount, "no item lost or duplicated");
  assert.equal(new Set(rows.map((row) => row.id)).size, expectedCount);
  assert.equal(new Set(rows.map((row) => String(row.backlog_rank))).size, expectedCount, "ranks stay unique");
  for (let index = 1; index < rows.length; index += 1) assert.ok(Number(rows[index - 1].backlog_rank) < Number(rows[index].backlog_rank), "strictly ordered");
}

test("concurrent moves of different items are serialized and keep a consistent order", async () => {
  const results = await Promise.all(ids.items.map((id, index) => move("pm1", id, ids.items[(index + 7) % 20], null)));
  for (const result of results) assert.equal(result.error, null);
  assertConsistent(await backlog(), 20);
});

test("concurrent moves into the same gap all land right after the anchor", async () => {
  const anchor = (await backlog())[0].id;
  const movers = (await backlog()).slice(5, 15).map((row) => row.id);
  const results = await Promise.all(movers.map((id) => move("pm1", id, anchor, null)));
  for (const result of results) assert.equal(result.error, null);
  const rows = await backlog();
  assertConsistent(rows, 20);
  assert.equal(rows[0].id, anchor);
  assert.deepEqual(new Set(rows.slice(1, 11).map((row) => row.id)), new Set(movers), "the ten moved items sit directly after the anchor");
});

test("concurrent creates and moves never collide", async () => {
  const rows = await backlog();
  const operations = [
    ...Array.from({ length: 8 }, (_, index) => users.pm1.client.rpc("create_work_item", { p_project_id: ids.project, p_type: "TASK", p_title: `Concurrent ${index}` })),
    ...rows.slice(0, 8).map((row) => move("pm1", row.id, null, rows[19].id)),
  ];
  const results = await Promise.all(operations);
  for (const result of results) assert.equal(result.error, null);
  const after = await backlog();
  assertConsistent(after, 28);
  assert.ok(after.slice(-8).every((row) => row.title.startsWith("Concurrent")), "new items are appended at the bottom");
});

test("reordering never changes status or other fields", async () => {
  const before = await backlog();
  await move("pm1", before[3].id, null, before[0].id);
  const after = await backlog();
  const byId = new Map(before.map((row) => [row.id, row]));
  for (const row of after) {
    const old = byId.get(row.id);
    assert.deepEqual([row.status, row.priority, row.assignee_id, row.epic_id], [old.status, old.priority, old.assignee_id, old.epic_id]);
  }
  assert.equal(after[0].id, before[3].id);
});

test("permissions: only SA / assigned PM plan; members read; others are denied", async () => {
  const rows = await backlog("dev1");
  assert.ok(rows.length > 0, "member developer reads the backlog");
  assert.equal((await move("dev1", rows[1].id, rows[2].id)).error?.code, "42501");
  const bulk = await users.dev1.client.rpc("bulk_update_work_items", { p_project_id: ids.project, p_work_item_ids: [rows[0].id], p_change_priority: true, p_priority: "low" });
  assert.equal(bulk.error?.code, "42501");
  const quick = await users.dev1.client.rpc("create_work_item", { p_project_id: ids.project, p_type: "BUG", p_title: "Dev quick bug" });
  assert.equal(quick.error, null, "developers can still quick-create bugs");

  for (const who of ["pm2", "dev2"]) {
    const list = await users[who].client.rpc("list_backlog", { p_project_id: ids.project });
    assert.equal(list.error?.code, "P0002", who);
    assert.equal((await move(who, rows[1].id, rows[2].id)).error?.code, "P0002", who);
  }
  const direct = await users.pm1.client.from("work_items").update({ backlog_rank: 1 }).eq("id", rows[0].id).select();
  assert.equal(direct.error?.code, "42501", "ranks cannot be written directly");
});

test("bulk updates are atomic and audited per item", async () => {
  const rows = (await backlog()).slice(0, 5);
  const selection = rows.map((row) => row.id);
  const ok = await users.pm1.client.rpc("bulk_update_work_items", {
    p_project_id: ids.project, p_work_item_ids: selection, p_change_priority: true, p_priority: "high", p_change_assignee: true, p_assignee_id: users.dev1.id,
  });
  assert.equal(ok.error, null);
  assert.equal(ok.data, 5);
  const updated = (await backlog()).filter((row) => selection.includes(row.id));
  assert.ok(updated.every((row) => row.priority === "high" && row.assignee_id === users.dev1.id));

  const bad = await users.pm1.client.rpc("bulk_update_work_items", {
    p_project_id: ids.project, p_work_item_ids: selection, p_change_assignee: true, p_assignee_id: users.dev2.id,
  });
  assert.equal(bad.error?.message, "invalid_assignee");
  const unchanged = (await backlog()).filter((row) => selection.includes(row.id));
  assert.ok(unchanged.every((row) => row.assignee_id === users.dev1.id), "nothing changed after a failed bulk update");

  const activity = await users.pm1.client.rpc("list_project_activity", { p_project_id: ids.project, p_limit: 101 });
  const assigned = activity.data.filter((entry) => entry.action === "WORK_ITEM_ASSIGNED" && selection.includes(entry.work_item_id));
  assert.equal(assigned.length, 5);
  assert.ok(activity.data.some((entry) => entry.action === "WORK_ITEM_REORDERED"), "moves appear in the activity history");
});

test("filters and pagination", async () => {
  const all = await backlog();
  const seen = [];
  for (let page = 1; page <= 10; page += 1) {
    const rows = await backlog("pm1", { p_page: page, p_page_size: 7 });
    if (!rows.length) break;
    seen.push(...rows.map((row) => row.id));
  }
  assert.deepEqual(seen, all.map((row) => row.id), "pages concatenate to the full ordered list without duplicates");

  const bugs = await backlog("pm1", { p_type: "BUG" });
  assert.ok(bugs.length >= 5 && bugs.every((row) => row.type === "BUG"));
  const unassigned = await backlog("pm1", { p_unassigned: true });
  assert.ok(unassigned.every((row) => row.assignee_id === null));
  assert.equal((await backlog("pm1", { p_epic_id: ids.epic })).length, 0, "no item belongs to the epic yet");
  const key = all[2].issue_key;
  assert.deepEqual((await backlog("pm1", { p_search: key })).map((row) => row.issue_key), [key]);

  const summary = await users.dev1.client.rpc("backlog_summary", { p_project_id: ids.project });
  assert.equal(summary.error, null);
  assert.equal(summary.data.find((row) => row.dimension === "total").item_count, all.length);
});
