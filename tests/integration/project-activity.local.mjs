// Integration check of the project activity feed (Phase 8C) through the REAL
// local Supabase HTTP stack (Auth + PostgREST). LOCAL ONLY.
//
//   node --env-file=.env.supabase-local --test tests/integration/project-activity.local.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { admin, createFixtures, runId } from "../helpers/project-fixtures.mjs";

const run = runId();
const { users, makeUser, cleanup } = createFixtures(`act-${run}`);
let projectId;

before(async () => {
  await makeUser("sa", "SUPER_ADMIN");
  await makeUser("pm1", "PROJECT_MANAGER");
  await makeUser("pm2", "PROJECT_MANAGER");
  await makeUser("dev1", "DEVELOPER");
  await makeUser("dev2", "DEVELOPER");

  const call = async (who, fn, args) => {
    const { data, error } = await users[who].client.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  // Real events only, each in its own request (so each has its own timestamp).
  projectId = await call("sa", "create_project", {
    p_name: `Activity ${run}`, p_project_key: `A${run}`, p_priority: "high", p_description: "Confidential roadmap", p_project_manager_id: users.pm1.id,
  });
  await call("pm1", "update_project", { p_project_id: projectId, p_name: `Activity ${run}`, p_status: "active", p_priority: "high", p_description: "Changed roadmap" });
  await call("pm1", "add_project_member", { p_project_id: projectId, p_profile_id: users.dev1.id });
  await call("pm1", "add_project_member", { p_project_id: projectId, p_profile_id: users.dev2.id });
  await call("pm1", "remove_project_member", { p_project_id: projectId, p_profile_id: users.dev2.id });
  await call("sa", "assign_project_manager", { p_project_id: projectId, p_project_manager_id: users.pm2.id });
  await call("pm2", "archive_project", { p_project_id: projectId });
  await call("pm2", "restore_project", { p_project_id: projectId });
});

after(cleanup);

const feed = (who, args = {}) => users[who].client.rpc("list_project_activity", { p_project_id: projectId, ...args });

test("Super Admin sees every event, newest first, with actors", async () => {
  const { data, error } = await feed("sa", { p_limit: 50 });
  assert.equal(error, null);
  assert.deepEqual(data.map((entry) => entry.action), [
    "PROJECT_RESTORED", "PROJECT_ARCHIVED", "PROJECT_MANAGER_CHANGED", "PROJECT_MEMBER_REMOVED",
    "PROJECT_MEMBER_ADDED", "PROJECT_MEMBER_ADDED", "PROJECT_UPDATED", "PROJECT_CREATED",
  ]);
  for (let i = 1; i < data.length; i += 1) assert.ok(data[i - 1].created_at >= data[i].created_at, "newest first");

  const byAction = (action) => data.find((entry) => entry.action === action);
  assert.equal(byAction("PROJECT_CREATED").actor_id, users.sa.id);
  assert.match(byAction("PROJECT_CREATED").actor_name, /^IT sa /);
  assert.equal(byAction("PROJECT_UPDATED").actor_id, users.pm1.id);
  assert.equal(byAction("PROJECT_ARCHIVED").actor_id, users.pm2.id);
  assert.match(byAction("PROJECT_MEMBER_REMOVED").subject_name, /^IT dev2 /);
  assert.match(byAction("PROJECT_MANAGER_CHANGED").previous_subject_name, /^IT pm1 /);
  assert.match(byAction("PROJECT_MANAGER_CHANGED").subject_name, /^IT pm2 /);
  assert.deepEqual(byAction("PROJECT_UPDATED").changes, [
    { field: "status", from: "planning", to: "active" },
    { field: "description" },
  ]);
  const raw = JSON.stringify(data);
  assert.doesNotMatch(raw, /Confidential|Changed roadmap/, "description text is never returned");
  assert.doesNotMatch(raw, /old_values|new_values|project_id/, "no raw audit structure");
});

test("cursor pagination returns everything once", async () => {
  const seen = [];
  let cursor = {};
  for (let guard = 0; guard < 10; guard += 1) {
    const { data, error } = await feed("sa", { p_limit: 3, ...cursor });
    assert.equal(error, null);
    seen.push(...data.map((entry) => entry.id));
    if (data.length < 3) break;
    const last = data[data.length - 1];
    cursor = { p_before_created_at: last.created_at, p_before_id: last.id };
  }
  const all = (await feed("sa", { p_limit: 50 })).data.map((entry) => entry.id);
  assert.equal(new Set(seen).size, seen.length, "no duplicates");
  assert.deepEqual(seen, all, "nothing missing, same order");
});

test("assigned PM and member developer can read the feed", async () => {
  assert.equal((await feed("pm2")).data.length, 8);
  assert.equal((await feed("dev1")).data.length, 8);
});

test("unrelated PM and non-member developer are denied", async () => {
  assert.equal((await feed("pm1")).error?.code, "P0002", "former PM is no longer assigned");
  assert.equal((await feed("dev2")).error?.code, "P0002", "removed developer is not a member");
});

test("no direct access to audit records", async () => {
  for (const who of ["sa", "pm2", "dev1"]) {
    const { error } = await users[who].client.schema("private").from("project_audit_log").select("*").limit(1);
    assert.ok(error, `${who} cannot reach the private schema`);
  }
  const service = await admin.schema("private").from("project_audit_log").select("*").limit(1);
  assert.ok(service.error, "not exposed even with the server key");
});
