// Integration check of work items (Phase 8D) through the REAL local Supabase
// HTTP stack (Auth + PostgREST). LOCAL ONLY.
//
//   node --env-file=.env.supabase-local --test tests/integration/work-items.local.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { localSql } from "../helpers/local-postgres.mjs";
import { admin, createFixtures, runId } from "../helpers/project-fixtures.mjs";

const run = runId();
const projectKey = `W${run}`;
const { users, makeUser, cleanup } = createFixtures(`work-${run}`);
const ids = {};

before(async () => {
  await makeUser("sa", "SUPER_ADMIN");
  await makeUser("pm1", "PROJECT_MANAGER");
  await makeUser("pm2", "PROJECT_MANAGER");
  await makeUser("dev1", "DEVELOPER");
  await makeUser("dev2", "DEVELOPER");
  const { data, error } = await users.pm1.client.rpc("create_project", { p_name: `Work ${run}`, p_project_key: projectKey, p_priority: "medium" });
  if (error) throw error;
  ids.project = data;
  const other = await users.pm2.client.rpc("create_project", { p_name: `Other ${run}`, p_project_key: `X${run}`, p_priority: "medium" });
  if (other.error) throw other.error;
  ids.other = other.data;
  const member = await users.pm1.client.rpc("add_project_member", { p_project_id: ids.project, p_profile_id: users.dev1.id });
  if (member.error) throw member.error;
});

after(cleanup);

const create = (who, args) => users[who].client.rpc("create_work_item", { p_project_id: ids.project, ...args });

test("concurrent creation never duplicates identifiers", async () => {
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, index) => create("pm1", { p_type: "TASK", p_title: `Parallel ${index}` })),
  );
  for (const result of results) assert.equal(result.error, null);
  const { data, error } = await users.pm1.client.rpc("list_work_items", { p_project_id: ids.project, p_page_size: 100, p_sort: "key_asc" });
  assert.equal(error, null);
  const keys = data.map((item) => item.issue_key);
  assert.equal(new Set(keys).size, 25, "unique keys");
  assert.deepEqual(data.map((item) => item.issue_number), Array.from({ length: 25 }, (_, index) => index + 1), "gapless 1..25");
  assert.ok(keys.every((key) => key.startsWith(`${projectKey}-`)));
});

test("every type and the hierarchy through the API", async () => {
  ids.epic = (await create("pm1", { p_type: "EPIC", p_title: "Epic" })).data;
  ids.story = (await create("pm1", { p_type: "STORY", p_title: "Story", p_parent_id: ids.epic })).data;
  ids.task = (await create("pm1", { p_type: "TASK", p_title: "Task", p_parent_id: ids.story, p_assignee_id: users.dev1.id, p_status: "TODO" })).data;
  ids.subtask = (await create("pm1", { p_type: "SUBTASK", p_title: "Subtask", p_parent_id: ids.task })).data;
  ids.bug = (await create("pm1", { p_type: "BUG", p_title: "Bug", p_parent_id: ids.task })).data;
  for (const key of ["epic", "story", "task", "subtask", "bug"]) assert.ok(ids[key], key);

  assert.equal((await create("pm1", { p_type: "STORY", p_title: "Bad", p_parent_id: ids.task })).error?.message, "invalid_parent");
  assert.equal((await create("pm1", { p_type: "SUBTASK", p_title: "Orphan" })).error?.message, "invalid_parent");
  const foreign = await users.pm2.client.rpc("create_work_item", { p_project_id: ids.other, p_type: "STORY", p_title: "Other" });
  assert.equal(foreign.error, null);
  assert.equal((await create("pm1", { p_type: "TASK", p_title: "Cross", p_parent_id: foreign.data })).error?.message, "invalid_parent", "cross-project parent");

  const children = await users.pm1.client.rpc("list_work_item_children", { p_work_item_id: ids.task });
  assert.deepEqual(children.data.map((child) => child.type).sort(), ["BUG", "SUBTASK"]);
});

test("developer permissions", async () => {
  const own = await create("dev1", { p_type: "BUG", p_title: "Found a bug", p_assignee_id: users.dev1.id });
  assert.equal(own.error, null);
  const detail = await users.dev1.client.rpc("get_work_item", { p_work_item_id: own.data });
  assert.equal(detail.data[0].reporter_id, users.dev1.id, "reporter comes from the session");

  assert.equal((await create("dev1", { p_type: "STORY", p_title: "No" })).error?.code, "42501");
  assert.equal((await create("dev1", { p_type: "TASK", p_title: "No", p_assignee_id: users.pm1.id })).error?.code, "42501");

  const status = (id, to) => users.dev1.client.rpc("change_work_item_status", { p_work_item_id: id, p_status: to });
  assert.equal((await status(ids.task, "IN_PROGRESS")).error, null, "assignee moves own work");
  assert.equal((await status(ids.task, "DONE")).error?.message, "invalid_transition");
  assert.equal((await status(ids.epic, "TODO")).error?.code, "42501", "cannot move unassigned work");
  assert.equal((await users.dev1.client.rpc("assign_work_item", { p_work_item_id: ids.epic, p_assignee_id: users.dev1.id })).error?.code, "42501");
  assert.equal((await users.dev1.client.rpc("change_work_item_priority", { p_work_item_id: ids.task, p_priority: "low" })).error?.code, "42501");
  assert.equal((await users.dev1.client.rpc("archive_work_item", { p_work_item_id: ids.task })).error?.code, "42501");

  const direct = await users.dev1.client.from("work_items").insert({ project_id: ids.project, type: "TASK", title: "Direct", reporter_id: users.pm1.id });
  assert.equal(direct.error?.code, "42501");
  const serviceDelete = await admin.from("work_items").delete().eq("id", ids.task);
  assert.equal(serviceDelete.error?.code, "42501", "no deletes even with the server key");
});

test("assignment is limited to active developers on the team", async () => {
  const assign = (assignee) => users.pm1.client.rpc("assign_work_item", { p_work_item_id: ids.subtask, p_assignee_id: assignee });
  assert.equal((await assign(users.dev2.id)).error?.message, "invalid_assignee", "non-member");
  assert.equal((await assign(users.pm2.id)).error?.message, "invalid_assignee", "not a developer");
  assert.equal((await assign(users.dev1.id)).error, null);
});

test("unrelated users cannot see or change the project's work", async () => {
  for (const who of ["pm2", "dev2"]) {
    assert.equal((await users[who].client.rpc("list_work_items", { p_project_id: ids.project })).error?.code, "P0002", who);
    assert.deepEqual((await users[who].client.rpc("get_work_item", { p_work_item_id: ids.task })).data, [], who);
    assert.equal((await users[who].client.rpc("update_work_item", { p_work_item_id: ids.task, p_title: "x" })).error?.code, "P0002", who);
    const rows = await users[who].client.from("work_items").select("id").eq("project_id", ids.project);
    assert.deepEqual(rows.data, [], `${who}: RLS hides rows`);
  }
  const member = await users.dev1.client.from("work_items").select("id").eq("project_id", ids.project);
  assert.ok(member.data.length >= 30, "member developer reads the project's items");
});

test("filtering and pagination", async () => {
  const page = (number) => users.pm1.client.rpc("list_work_items", { p_project_id: ids.project, p_sort: "key_asc", p_page: number, p_page_size: 10 });
  const seen = [];
  for (let number = 1; number <= 5; number += 1) {
    const { data } = await page(number);
    if (!data.length) break;
    seen.push(...data.map((item) => item.issue_number));
  }
  assert.equal(new Set(seen).size, seen.length, "no duplicates across pages");
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "stable order");

  const bugs = await users.pm1.client.rpc("list_work_items", { p_project_id: ids.project, p_type: "BUG" });
  assert.ok(bugs.data.length >= 2 && bugs.data.every((item) => item.type === "BUG"));
  const byKey = await users.pm1.client.rpc("list_work_items", { p_project_id: ids.project, p_search: `${projectKey}-3` });
  assert.deepEqual(byKey.data.map((item) => item.issue_key), [`${projectKey}-3`]);
  const mine = await users.pm1.client.rpc("list_work_items", { p_project_id: ids.project, p_assignee_id: users.dev1.id });
  assert.ok(mine.data.every((item) => item.assignee_id === users.dev1.id));
});

test("work item changes are audited and appear in the item's history", async () => {
  const { data, error } = await users.dev1.client.rpc("list_project_activity", { p_project_id: ids.project, p_work_item_id: ids.task, p_limit: 50 });
  assert.equal(error, null);
  assert.deepEqual(data.map((entry) => entry.action).sort(), ["WORK_ITEM_CREATED", "WORK_ITEM_STATUS_CHANGED"]);
  assert.ok(data.every((entry) => entry.work_item_key && entry.work_item_id === ids.task));
  const status = data.find((entry) => entry.action === "WORK_ITEM_STATUS_CHANGED");
  assert.equal(status.actor_id, users.dev1.id);
  assert.deepEqual(status.changes, [{ field: "status", from: "TODO", to: "IN_PROGRESS" }]);

  const counts = localSql(`select action, count(*) from private.project_audit_log where project_id = '${ids.project}' and work_item_id is not null group by action order by action;`);
  assert.equal(counts.code, 0, counts.stderr);
  assert.match(counts.stdout, /WORK_ITEM_ASSIGNED\|1/);
  assert.match(counts.stdout, /WORK_ITEM_CREATED\|31/);
});
