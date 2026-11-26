// Integration check of sprint management (Phase 8F1) through the REAL local
// Supabase HTTP stack, including concurrent starts. LOCAL ONLY.
//
//   node --env-file=.env.supabase-local --test tests/integration/sprints.local.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { localSql } from "../helpers/local-postgres.mjs";
import { admin, createFixtures, runId } from "../helpers/project-fixtures.mjs";

const run = runId();
const { users, makeUser, cleanup } = createFixtures(`sprint-${run}`);
const ids = { items: [], sprints: [] };

before(async () => {
  await makeUser("pm1", "PROJECT_MANAGER");
  await makeUser("pm2", "PROJECT_MANAGER");
  await makeUser("dev1", "DEVELOPER");
  await makeUser("dev2", "DEVELOPER");
  const project = await users.pm1.client.rpc("create_project", { p_name: `Sprints ${run}`, p_project_key: `S${run}`, p_priority: "medium" });
  if (project.error) throw project.error;
  ids.project = project.data;
  const other = await users.pm2.client.rpc("create_project", { p_name: `Other ${run}`, p_project_key: `O${run}`, p_priority: "medium" });
  if (other.error) throw other.error;
  ids.other = other.data;
  ids.foreignItem = (await users.pm2.client.rpc("create_work_item", { p_project_id: ids.other, p_type: "TASK", p_title: "Foreign" })).data;
  await users.pm1.client.rpc("add_project_member", { p_project_id: ids.project, p_profile_id: users.dev1.id });
  for (let index = 0; index < 12; index += 1) {
    const { data, error } = await users.pm1.client.rpc("create_work_item", {
      p_project_id: ids.project, p_type: index % 3 === 0 ? "BUG" : "TASK", p_title: `Item ${index}`, p_status: "TODO",
      p_estimate: index % 4 === 0 ? undefined : index, p_assignee_id: index % 2 ? users.dev1.id : undefined,
    });
    if (error) throw error;
    ids.items.push(data);
  }
  ids.epic = (await users.pm1.client.rpc("create_work_item", { p_project_id: ids.project, p_type: "EPIC", p_title: "Epic" })).data;
  for (let index = 0; index < 3; index += 1) {
    const { data, error } = await users.pm1.client.rpc("create_sprint", {
      p_project_id: ids.project, p_name: `Sprint ${index + 1}`, p_start_date: `2027-0${index + 1}-01`, p_end_date: `2027-0${index + 1}-14`, p_capacity_points: 20,
    });
    if (error) throw error;
    ids.sprints.push(data);
  }
});

after(cleanup);

const pm = () => users.pm1.client;

test("planning: add, eligibility, duplicates, capacity", async () => {
  const added = await pm().rpc("add_work_items_to_sprint", { p_sprint_id: ids.sprints[0], p_work_item_ids: ids.items.slice(0, 6) });
  assert.equal(added.error, null);
  assert.equal(added.data, 6);
  assert.equal((await pm().rpc("add_work_items_to_sprint", { p_sprint_id: ids.sprints[0], p_work_item_ids: [ids.items[0]] })).error?.message, "already_in_sprint");
  assert.equal((await pm().rpc("add_work_items_to_sprint", { p_sprint_id: ids.sprints[1], p_work_item_ids: [ids.items[0]] })).error?.message, "in_another_sprint");
  assert.equal((await pm().rpc("add_work_items_to_sprint", { p_sprint_id: ids.sprints[1], p_work_item_ids: [ids.epic] })).error?.message, "not_schedulable");
  assert.equal((await pm().rpc("add_work_items_to_sprint", { p_sprint_id: ids.sprints[1], p_work_item_ids: [ids.foreignItem] })).error?.message, "invalid_selection");

  const { data: sprint } = await pm().rpc("get_sprint", { p_sprint_id: ids.sprints[0] });
  // Estimates of items 0..5: none, 1, 2, 3, none, 5 -> 11 points, 2 unestimated.
  assert.deepEqual([sprint[0].item_count, Number(sprint[0].estimate_total), sprint[0].unestimated_count, Number(sprint[0].capacity_points)], [6, 11, 2, 20]);
  const { data: capacity } = await pm().rpc("sprint_capacity", { p_sprint_id: ids.sprints[0] });
  const dev = capacity.find((row) => row.assignee_id === users.dev1.id);
  assert.deepEqual([dev.item_count, Number(dev.estimate_total)], [3, 9], "items 1, 3, 5 belong to dev1");

  const backlog = await pm().rpc("list_backlog", { p_project_id: ids.project, p_page_size: 100 });
  assert.ok(!backlog.data.some((row) => ids.items.slice(0, 6).includes(row.id)), "planned items leave the backlog");
});

test("over capacity is reported, never blocking", async () => {
  const added = await pm().rpc("add_work_items_to_sprint", { p_sprint_id: ids.sprints[1], p_work_item_ids: ids.items.slice(6, 12) });
  assert.equal(added.error, null, "planning beyond capacity is allowed");
  const { data } = await pm().rpc("get_sprint", { p_sprint_id: ids.sprints[1] });
  assert.ok(Number(data[0].estimate_total) > Number(data[0].capacity_points), "planned 6+7+9+10+11 = 43 > 20");
});

test("concurrent starts: exactly one sprint becomes active", async () => {
  const results = await Promise.all([ids.sprints[0], ids.sprints[1], ids.sprints[0], ids.sprints[1]].map((id) => pm().rpc("start_sprint", { p_sprint_id: id })));
  const succeeded = results.filter((result) => !result.error);
  assert.equal(succeeded.length, 1, "one start wins");
  for (const result of results.filter((result) => result.error)) {
    assert.ok(["active_sprint_exists", "invalid_sprint_transition"].includes(result.error.message), result.error.message);
  }
  const { data } = await pm().rpc("list_sprints", { p_project_id: ids.project, p_scope: "open" });
  assert.equal(data.filter((sprint) => sprint.status === "ACTIVE").length, 1);
  ids.active = data.find((sprint) => sprint.status === "ACTIVE").id;
  ids.planned = ids.sprints.filter((id) => id !== ids.active);
  const items = await pm().rpc("list_sprint_items", { p_sprint_id: ids.active });
  assert.ok(items.data.every((item) => item.status === "TODO"), "starting does not move work to In progress");
});

test("developers read sprints but cannot plan; outsiders see nothing", async () => {
  const list = await users.dev1.client.rpc("list_sprints", { p_project_id: ids.project });
  assert.equal(list.error, null);
  assert.equal(list.data.length, 3);
  const items = await users.dev1.client.rpc("list_sprint_items", { p_sprint_id: ids.active });
  assert.equal(items.error, null);
  for (const [fn, args] of [
    ["create_sprint", { p_project_id: ids.project, p_name: "Dev" }],
    ["update_sprint", { p_sprint_id: ids.planned[0], p_name: "Dev" }],
    ["set_sprint_capacity", { p_sprint_id: ids.planned[0], p_capacity_points: 1 }],
    ["add_work_items_to_sprint", { p_sprint_id: ids.planned[0], p_work_item_ids: [ids.items[0]] }],
    ["remove_work_items_from_sprint", { p_sprint_id: ids.active, p_work_item_ids: [items.data[0].id] }],
    ["start_sprint", { p_sprint_id: ids.planned[0] }],
    ["complete_sprint", { p_sprint_id: ids.active, p_carry_over: "backlog" }],
    ["cancel_sprint", { p_sprint_id: ids.planned[0] }],
  ]) {
    assert.equal((await users.dev1.client.rpc(fn, args)).error?.code, "42501", fn);
  }
  for (const who of ["pm2", "dev2"]) {
    assert.equal((await users[who].client.rpc("list_sprints", { p_project_id: ids.project })).error?.code, "P0002", who);
    assert.deepEqual((await users[who].client.rpc("get_sprint", { p_sprint_id: ids.active })).data, [], who);
    assert.deepEqual((await users[who].client.from("sprints").select("id").eq("project_id", ids.project)).data, [], `${who}: RLS`);
  }
  const direct = await pm().from("sprints").update({ name: "Direct" }).eq("id", ids.active).select();
  assert.equal(direct.error?.code, "42501", "no direct writes");
  const serviceDelete = await admin.from("sprints").delete().eq("id", ids.active);
  assert.equal(serviceDelete.error?.code, "42501", "no deletes, even with the server key");
});

test("move between sprints is atomic", async () => {
  const { data: source } = await pm().rpc("list_sprint_items", { p_sprint_id: ids.active });
  const moving = source.slice(0, 2).map((item) => item.id);
  const bad = await pm().rpc("move_work_items_between_sprints", { p_from_sprint_id: ids.active, p_to_sprint_id: ids.planned[0], p_work_item_ids: [...moving, ids.epic] });
  assert.ok(bad.error, "a bad id fails the whole move");
  const unchanged = await pm().rpc("list_sprint_items", { p_sprint_id: ids.active });
  assert.equal(unchanged.data.length, source.length, "nothing moved");
  const ok = await pm().rpc("move_work_items_between_sprints", { p_from_sprint_id: ids.active, p_to_sprint_id: ids.planned[0], p_work_item_ids: moving });
  assert.equal(ok.error, null);
  const target = await pm().rpc("list_sprint_items", { p_sprint_id: ids.planned[0] });
  assert.ok(moving.every((id) => target.data.some((item) => item.id === id)));
});

test("completing requires a decision for unfinished work and never marks it done", async () => {
  const { data: before } = await pm().rpc("list_sprint_items", { p_sprint_id: ids.active });
  const finishing = before.find((item) => item.assignee_id === users.dev1.id);
  for (const status of ["IN_PROGRESS", "IN_REVIEW"]) {
    const { error } = await users.dev1.client.rpc("change_work_item_status", { p_work_item_id: finishing.id, p_status: status });
    assert.equal(error, null, status);
  }
  // Approval is manager-only (8F2).
  assert.equal((await pm().rpc("change_work_item_status", { p_work_item_id: finishing.id, p_status: "DONE" })).error, null);
  assert.equal((await pm().rpc("complete_sprint", { p_sprint_id: ids.active })).error?.message, "unfinished_work_requires_decision");
  const done = await pm().rpc("complete_sprint", { p_sprint_id: ids.active, p_carry_over: "sprint", p_target_sprint_id: ids.planned[1] });
  assert.equal(done.error, null);
  assert.equal(done.data, before.length - 1, "every unfinished item was carried over");

  const kept = await pm().rpc("list_sprint_items", { p_sprint_id: ids.active });
  assert.deepEqual(kept.data.map((item) => item.id), [finishing.id], "completed work stays with the sprint");
  const carried = await pm().rpc("list_sprint_items", { p_sprint_id: ids.planned[1] });
  const carriedIds = before.filter((item) => item.id !== finishing.id).map((item) => item.id);
  assert.ok(carriedIds.every((id) => carried.data.some((item) => item.id === id && item.status === "TODO")), "carried items keep their status");
});

test("cancelling a planned sprint returns its items to the backlog", async () => {
  const { data: planned } = await pm().rpc("list_sprint_items", { p_sprint_id: ids.planned[0] });
  const cancelled = await pm().rpc("cancel_sprint", { p_sprint_id: ids.planned[0] });
  assert.equal(cancelled.error, null);
  assert.equal(cancelled.data, planned.length);
  const backlog = await pm().rpc("list_backlog", { p_project_id: ids.project, p_page_size: 100 });
  assert.ok(planned.every((item) => backlog.data.some((row) => row.id === item.id)), "nothing discarded");
  assert.equal((await pm().rpc("add_work_items_to_sprint", { p_sprint_id: ids.planned[0], p_work_item_ids: [planned[0].id] })).error?.message, "sprint_closed");
});

test("history: sprint events are audited with the actor and shown in activity", async () => {
  const counts = localSql(`select action, count(*) from private.project_audit_log where project_id = '${ids.project}'
    and (action like 'SPRINT_%' or action like '%SPRINT%') group by action order by action;`);
  assert.equal(counts.code, 0, counts.stderr);
  for (const action of ["SPRINT_CREATED", "SPRINT_STARTED", "SPRINT_COMPLETED", "SPRINT_CANCELLED", "WORK_ITEM_ADDED_TO_SPRINT", "WORK_ITEM_REMOVED_FROM_SPRINT", "WORK_ITEM_MOVED_BETWEEN_SPRINTS"]) {
    assert.match(counts.stdout, new RegExp(`${action}\\|`), action);
  }
  const feed = await users.dev1.client.rpc("list_project_activity", { p_project_id: ids.project, p_limit: 101 });
  const completed = feed.data.find((entry) => entry.action === "SPRINT_COMPLETED");
  assert.equal(completed.actor_id, users.pm1.id);
  assert.ok(completed.sprint_name && completed.previous_subject_name, "sprint and carry-over target are named");

  const page = await pm().rpc("list_sprints", { p_project_id: ids.project, p_scope: "all", p_page: 2, p_page_size: 2 });
  assert.equal(page.data.length, 1);
  assert.equal(Number(page.data[0].total_count), 3);
});
