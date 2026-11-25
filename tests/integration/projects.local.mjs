// Integration check of the project RPCs and RLS through the REAL local
// Supabase HTTP stack (Auth + PostgREST). LOCAL ONLY: refuses non-loopback URLs.
//
//   node --env-file=.env.supabase-local --test tests/integration/projects.local.mjs
//
// Creates throwaway SUPER_ADMIN / PROJECT_MANAGER / DEVELOPER users and their
// projects, then removes them. Projects cannot be deleted through any API role,
// so cleanup runs as the table owner through the local database container.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createClient } from "@supabase/supabase-js";

import { localSql } from "../helpers/local-postgres.mjs";

const url = process.env.API_URL;
const anonKey = process.env.PUBLISHABLE_KEY ?? process.env.ANON_KEY;
const serviceKey = process.env.SECRET_KEY ?? process.env.SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) throw new Error("Load `supabase status -o env` output first.");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("Refusing to run against a non-local Supabase URL.");
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const run = randomUUID().slice(0, 4).toUpperCase().replace(/[^A-Z]/g, "X");
const key = (suffix) => `I${run}${suffix}`.slice(0, 10);
const users = {};
const projects = {};

async function makeUser(name, role) {
  const email = `it-proj-${run.toLowerCase()}-${name}@cyclo.test`;
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { role: "SUPER_ADMIN" } });
  if (error) throw error;
  const id = data.user.id;
  const { error: updateError } = await admin.from("profiles").update({ role, is_active: true, full_name: `IT ${name}` }).eq("id", id);
  if (updateError) throw updateError;
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  users[name] = { id, client };
}

before(async () => {
  await makeUser("sa", "SUPER_ADMIN");
  await makeUser("pm1", "PROJECT_MANAGER");
  await makeUser("pm2", "PROJECT_MANAGER");
  await makeUser("dev", "DEVELOPER");
});

after(async () => {
  const ids = Object.values(users).map(({ id }) => id).filter((id) => /^[0-9a-f-]{36}$/.test(id));
  if (ids.length) {
    const list = ids.map((id) => `'${id}'`).join(",");
    const result = localSql(`begin;
      alter table public.projects disable trigger projects_prevent_delete;
      delete from public.projects where project_manager_id in (${list}) or created_by in (${list});
      alter table public.projects enable trigger projects_prevent_delete;
      delete from private.project_audit_log where actor_id in (${list});
      update public.profiles set role = 'DEVELOPER' where id in (${list});
      commit;`);
    if (result.code !== 0) console.error(result.stderr);
  }
  for (const { id, client } of Object.values(users)) {
    await client.auth.signOut();
    await admin.auth.admin.deleteUser(id);
  }
});

test("Super Admin creates a project for an active PM", async () => {
  const { data, error } = await users.sa.client.rpc("create_project", {
    p_name: "Integration Web", p_project_key: key("W").toLowerCase(), p_priority: "high",
    p_start_date: "2026-12-01", p_target_date: "2027-01-31", p_project_manager_id: users.pm1.id,
  });
  assert.equal(error, null);
  projects.web = data;
  const { data: rows } = await users.sa.client.rpc("get_project", { p_project_id: data });
  assert.equal(rows[0].project_key, key("W"));
  assert.equal(rows[0].project_manager_id, users.pm1.id);
  assert.equal(rows[0].created_by, users.sa.id);
});

test("Project Manager creates a project and is assigned automatically", async () => {
  const { data, error } = await users.pm2.client.rpc("create_project", { p_name: "Integration Ops", p_project_key: key("O"), p_priority: "low" });
  assert.equal(error, null);
  projects.ops = data;
  const { data: rows } = await users.pm2.client.rpc("get_project", { p_project_id: data });
  assert.equal(rows[0].project_manager_id, users.pm2.id);
});

test("Project Manager cannot assign another PM on create", async () => {
  const { error } = await users.pm1.client.rpc("create_project", {
    p_name: "Hijack", p_project_key: key("H"), p_priority: "low", p_project_manager_id: users.pm2.id,
  });
  assert.equal(error?.code, "42501");
});

test("Developer cannot create projects (RPC or direct insert)", async () => {
  const rpc = await users.dev.client.rpc("create_project", { p_name: "Dev", p_project_key: key("D"), p_priority: "low" });
  assert.equal(rpc.error?.code, "42501");
  const direct = await users.dev.client.from("projects").insert({
    name: "Dev", project_key: key("D"), project_manager_id: users.pm1.id, created_by: users.dev.id,
  });
  assert.equal(direct.error?.code, "42501");
});

test("duplicate keys and invalid dates are rejected", async () => {
  const duplicate = await users.pm1.client.rpc("create_project", { p_name: "Dup", p_project_key: key("W"), p_priority: "low" });
  assert.equal(duplicate.error?.code, "23505");
  assert.equal(duplicate.error?.message, "duplicate_project_key");
  const dates = await users.pm1.client.rpc("create_project", {
    p_name: "Dates", p_project_key: key("X"), p_priority: "low", p_start_date: "2027-02-01", p_target_date: "2027-01-01",
  });
  assert.equal(dates.error?.code, "22023");
  assert.equal(dates.error?.message, "invalid_date_range");
});

test("listing is isolated per role", async () => {
  const mine = (client) => client.rpc("list_projects", { p_search: `I${run}`, p_page_size: 100 });
  const sa = await mine(users.sa.client);
  assert.deepEqual(sa.data.map((p) => p.project_key).sort(), [key("O"), key("W")].sort());
  const pm1 = await mine(users.pm1.client);
  assert.deepEqual(pm1.data.map((p) => p.project_key), [key("W")]);
  const pm2 = await mine(users.pm2.client);
  assert.deepEqual(pm2.data.map((p) => p.project_key), [key("O")]);
  const dev = await mine(users.dev.client);
  assert.deepEqual(dev.data, []);

  const direct = await users.pm1.client.from("projects").select("project_key").in("id", [projects.web, projects.ops]);
  assert.deepEqual(direct.data.map((p) => p.project_key), [key("W")], "RLS hides other PMs' projects");
  const devDirect = await users.dev.client.from("projects").select("id").in("id", [projects.web, projects.ops]);
  assert.deepEqual(devDirect.data, []);
});

test("PM isolation for detail, update and archive", async () => {
  const detail = await users.pm1.client.rpc("get_project", { p_project_id: projects.ops });
  assert.deepEqual(detail.data, []);
  const update = await users.pm1.client.rpc("update_project", { p_project_id: projects.ops, p_name: "Taken", p_status: "active", p_priority: "low" });
  assert.equal(update.error?.code, "P0002");
  const archive = await users.pm1.client.rpc("archive_project", { p_project_id: projects.ops });
  assert.equal(archive.error?.code, "P0002");
  const directUpdate = await users.pm1.client.from("projects").update({ name: "Taken" }).eq("id", projects.web).select();
  assert.equal(directUpdate.error?.code, "42501", "no direct UPDATE privilege");
});

test("only the Super Admin reassigns the PM", async () => {
  const byPm = await users.pm1.client.rpc("assign_project_manager", { p_project_id: projects.web, p_project_manager_id: users.pm2.id });
  assert.equal(byPm.error?.code, "42501");
  const options = await users.pm1.client.rpc("list_project_manager_options");
  assert.equal(options.error?.code, "42501");

  const bySa = await users.sa.client.rpc("assign_project_manager", { p_project_id: projects.web, p_project_manager_id: users.pm2.id });
  assert.equal(bySa.error, null);
  const pm1 = await users.pm1.client.rpc("get_project", { p_project_id: projects.web });
  assert.deepEqual(pm1.data, [], "previous PM loses access");
  const pm2 = await users.pm2.client.rpc("get_project", { p_project_id: projects.web });
  assert.equal(pm2.data[0].project_manager_id, users.pm2.id);

  const toDev = await users.sa.client.rpc("assign_project_manager", { p_project_id: projects.web, p_project_manager_id: users.dev.id });
  assert.equal(toDev.error?.message, "invalid_project_manager");
});

test("archive hides the project from the active list, blocks edits, and restores", async () => {
  const archived = await users.pm2.client.rpc("archive_project", { p_project_id: projects.ops });
  assert.equal(archived.error, null);
  const active = await users.pm2.client.rpc("list_projects", { p_search: key("O") });
  assert.deepEqual(active.data, []);
  const archivedList = await users.pm2.client.rpc("list_projects", { p_search: key("O"), p_archived: true });
  assert.equal(archivedList.data.length, 1);
  const edit = await users.pm2.client.rpc("update_project", { p_project_id: projects.ops, p_name: "Ops", p_status: "active", p_priority: "low" });
  assert.equal(edit.error?.message, "project_archived");
  const restored = await users.pm2.client.rpc("restore_project", { p_project_id: projects.ops });
  assert.equal(restored.error, null);
});

test("no API role can delete projects", async () => {
  const asPm = await users.pm2.client.from("projects").delete().eq("id", projects.ops);
  assert.equal(asPm.error?.code, "42501");
  const asService = await admin.from("projects").delete().eq("id", projects.ops);
  assert.equal(asService.error?.code, "42501");
  const still = await users.sa.client.rpc("get_project", { p_project_id: projects.ops });
  assert.equal(still.data.length, 1);
});

test("project actions are audited with the actor", () => {
  const result = localSql(`select action || ':' || actor_id from private.project_audit_log
    where project_id in ('${projects.web}','${projects.ops}') order by created_at, action;`);
  assert.equal(result.code, 0, result.stderr);
  const rows = result.stdout.trim().split("\n");
  assert.ok(rows.includes(`PROJECT_CREATED:${users.sa.id}`));
  assert.ok(rows.includes(`PROJECT_CREATED:${users.pm2.id}`));
  assert.ok(rows.includes(`PROJECT_MANAGER_CHANGED:${users.sa.id}`));
  assert.ok(rows.includes(`PROJECT_ARCHIVED:${users.pm2.id}`));
  assert.ok(rows.includes(`PROJECT_RESTORED:${users.pm2.id}`));
});
