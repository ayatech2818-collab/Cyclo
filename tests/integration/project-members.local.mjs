// Integration check of project team management (Phase 8B) through the REAL
// local Supabase HTTP stack (Auth + PostgREST). LOCAL ONLY.
//
//   node --env-file=.env.supabase-local --test tests/integration/project-members.local.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { localSql } from "../helpers/local-postgres.mjs";
import { admin, createFixtures, runId } from "../helpers/project-fixtures.mjs";

const run = runId();
const key = (suffix) => `T${run}${suffix}`.slice(0, 10);
const { users, makeUser, cleanup } = createFixtures(`team-${run}`);
const projects = {};

before(async () => {
  await makeUser("sa", "SUPER_ADMIN");
  await makeUser("pm1", "PROJECT_MANAGER");
  await makeUser("pm2", "PROJECT_MANAGER");
  await makeUser("dev1", "DEVELOPER");
  await makeUser("dev2", "DEVELOPER");
  await makeUser("devoff", "DEVELOPER", { isActive: false });

  for (const [name, owner] of [["alpha", "pm1"], ["beta", "pm1"], ["gamma", "pm2"]]) {
    const { data, error } = await users[owner].client.rpc("create_project", {
      p_name: `Team ${name} ${run}`, p_project_key: key(name[0].toUpperCase()), p_priority: "medium",
    });
    if (error) throw error;
    projects[name] = data;
  }
});

after(cleanup);

const add = (who, project, member) => users[who].client.rpc("add_project_member", { p_project_id: projects[project], p_profile_id: users[member].id });
const remove = (who, project, member) => users[who].client.rpc("remove_project_member", { p_project_id: projects[project], p_profile_id: users[member].id });
const visibleKeys = async (who) => {
  const { data, error } = await users[who].client.rpc("list_projects", { p_search: `T${run}`, p_page_size: 100 });
  assert.equal(error, null);
  return data.map((project) => project.project_key).sort();
};

test("developers see no projects before membership", async () => {
  assert.deepEqual(await visibleKeys("dev1"), []);
});

test("assigned PM searches and adds active developers", async () => {
  const { data, error } = await users.pm1.client.rpc("list_assignable_developers", { p_project_id: projects.alpha, p_search: `team-${run}`.toLowerCase() });
  assert.equal(error, null);
  assert.deepEqual(data.map((option) => option.id).sort(), [users.dev1.id, users.dev2.id].sort(), "inactive and non-developers are not offered");

  assert.equal((await add("pm1", "alpha", "dev1")).error, null);
  assert.equal((await add("pm1", "beta", "dev1")).error, null, "a developer can join several projects");
});

test("duplicate membership is prevented", async () => {
  const { error } = await add("pm1", "alpha", "dev1");
  assert.equal(error?.code, "23505");
  assert.equal(error?.message, "duplicate_member");
});

test("inactive employees and non-developers cannot be added", async () => {
  assert.equal((await add("pm1", "alpha", "devoff")).error?.message, "invalid_member");
  assert.equal((await add("pm1", "alpha", "pm2")).error?.message, "invalid_member");
  assert.equal((await add("pm1", "alpha", "pm1")).error?.message, "invalid_member", "the assigned PM is never a member");
  assert.equal((await add("pm1", "alpha", "sa")).error?.message, "invalid_member");
});

test("another PM cannot manage or read the team", async () => {
  assert.equal((await add("pm2", "alpha", "dev2")).error?.code, "P0002");
  assert.equal((await remove("pm2", "alpha", "dev1")).error?.code, "P0002");
  const members = await users.pm2.client.rpc("list_project_members", { p_project_id: projects.alpha });
  assert.equal(members.error?.code, "P0002");
  const direct = await users.pm2.client.from("project_members").select("id").eq("project_id", projects.alpha);
  assert.deepEqual(direct.data, [], "RLS hides the rows");
});

test("Super Admin manages any team", async () => {
  assert.equal((await add("sa", "gamma", "dev2")).error, null);
  const { data } = await users.sa.client.rpc("list_project_members", { p_project_id: projects.gamma });
  assert.deepEqual(data.map((member) => member.profile_id), [users.dev2.id]);
  assert.equal(data[0].added_by, users.sa.id);
});

test("developers see only the projects they belong to", async () => {
  assert.deepEqual(await visibleKeys("dev1"), [key("A"), key("B")].sort());
  assert.deepEqual(await visibleKeys("dev2"), [key("G")]);

  const detail = await users.dev1.client.rpc("get_project", { p_project_id: projects.gamma });
  assert.deepEqual(detail.data, [], "another team's project is not visible");
  const direct = await users.dev1.client.from("projects").select("project_key").in("id", Object.values(projects));
  assert.deepEqual(direct.data.map((project) => project.project_key).sort(), [key("A"), key("B")].sort());

  const team = await users.dev1.client.rpc("list_project_members", { p_project_id: projects.alpha });
  assert.equal(team.error, null);
  assert.deepEqual(team.data.map((member) => member.profile_id), [users.dev1.id]);
});

test("developers cannot add or remove members, including themselves", async () => {
  assert.equal((await add("dev1", "alpha", "dev2")).error?.code, "42501");
  assert.equal((await remove("dev1", "alpha", "dev1")).error?.code, "42501");
  const insert = await users.dev1.client.from("project_members").insert({ project_id: projects.gamma, profile_id: users.dev1.id, added_by: users.dev1.id });
  assert.equal(insert.error?.code, "42501");
  const del = await users.dev1.client.from("project_members").delete().eq("profile_id", users.dev1.id);
  assert.equal(del.error?.code, "42501");
  const serviceInsert = await admin.from("project_members").insert({ project_id: projects.gamma, profile_id: users.dev1.id, added_by: users.sa.id });
  assert.equal(serviceInsert.error?.code, "42501", "no write path even for the server key");
});

test("removing a developer revokes access immediately", async () => {
  assert.equal((await remove("pm1", "beta", "dev1")).error, null);
  assert.deepEqual(await visibleKeys("dev1"), [key("A")]);
  assert.equal((await remove("pm1", "beta", "dev1")).error?.message, "member_not_found");
});

test("team changes are audited with the actor", () => {
  const result = localSql(`select action || ':' || actor_id || ':' || coalesce(new_values->>'profile_id', old_values->>'profile_id')
    from private.project_audit_log where project_id in ('${projects.alpha}','${projects.beta}','${projects.gamma}')
     and action like 'PROJECT_MEMBER_%';`);
  assert.equal(result.code, 0, result.stderr);
  const rows = result.stdout.trim().split("\n");
  assert.ok(rows.includes(`PROJECT_MEMBER_ADDED:${users.pm1.id}:${users.dev1.id}`));
  assert.ok(rows.includes(`PROJECT_MEMBER_ADDED:${users.sa.id}:${users.dev2.id}`));
  assert.ok(rows.includes(`PROJECT_MEMBER_REMOVED:${users.pm1.id}:${users.dev1.id}`));
  assert.equal(rows.length, 4, "failed attempts are not audited");
});
