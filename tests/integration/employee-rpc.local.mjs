// Integration check of the employee read RPCs through the REAL local Supabase
// HTTP stack (Auth + PostgREST). LOCAL ONLY: refuses any non-loopback URL.
//
//   npx supabase status -o env > .env.supabase-local   (gitignored by .env.*)
//   node --env-file=.env.supabase-local --test tests/integration/employee-rpc.local.mjs
//
// Creates throwaway PROJECT_MANAGER / DEVELOPER users and deletes them at the
// end. Super Admin behaviour is covered by the pgTAP suite (a Super Admin test
// user could not be deleted again because of the last-admin protection).
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createClient } from "@supabase/supabase-js";

const url = process.env.API_URL;
const anonKey = process.env.PUBLISHABLE_KEY ?? process.env.ANON_KEY;
const serviceKey = process.env.SECRET_KEY ?? process.env.SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) throw new Error("Load `supabase status -o env` output first.");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("Refusing to run against a non-local Supabase URL.");
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const run = randomUUID().slice(0, 8);
const users = {};

async function makeUser(key, role, isActive = true) {
  const email = `it-${run}-${key}@cyclo.test`;
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { role: "SUPER_ADMIN" }, // must be ignored
  });
  if (error) throw error;
  const id = data.user.id;
  const { error: updateError } = await admin
    .from("profiles")
    .update({ role, is_active: isActive, full_name: `IT ${key} ${run}` })
    .eq("id", id);
  if (updateError) throw updateError;

  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  users[key] = { id, client };
}

before(async () => {
  await makeUser("pm", "PROJECT_MANAGER");
  await makeUser("dev", "DEVELOPER");
  await makeUser("dev_off", "DEVELOPER", false);
});

after(async () => {
  for (const { id, client } of Object.values(users)) {
    await client.auth.signOut();
    await admin.auth.admin.deleteUser(id);
  }
});

test("project manager lists employees with directory fields only", async () => {
  const { data, error } = await users.pm.client.rpc("list_employees", { p_search: run, p_page_size: 10 });
  assert.equal(error, null);
  assert.equal(data.length, 3, "includes the inactive employee");
  assert.deepEqual(
    Object.keys(data[0]).sort(),
    ["avatar_url", "email", "employee_code", "full_name", "id", "is_active", "role", "total_count"],
  );
});

test("project manager cannot read administrative detail or columns", async () => {
  const detail = await users.pm.client.rpc("admin_get_employee", { p_employee_id: users.dev.id });
  assert.equal(detail.error?.code, "42501");
  const columns = await users.pm.client.from("profiles").select("id, invited_by, is_git_organizer");
  assert.equal(columns.error?.code, "42501");
});

test("developer is denied the directory but can read own profile", async () => {
  const list = await users.dev.client.rpc("list_employees");
  assert.equal(list.error?.code, "42501");
  const other = await users.dev.client.rpc("get_employee", { p_employee_id: users.pm.id });
  assert.equal(other.error?.code, "42501");
  const own = await users.dev.client.rpc("get_my_profile");
  assert.equal(own.error, null);
  assert.equal(own.data[0].id, users.dev.id);
  assert.equal(own.data[0].role, "DEVELOPER", "metadata did not elevate the role");
});

test("existing auth projection still works through the table API", async () => {
  const { data, error } = await users.dev.client
    .from("profiles").select("id, full_name, email, role, is_active").eq("id", users.dev.id).maybeSingle();
  assert.equal(error, null);
  assert.equal(data.id, users.dev.id);
});

test("inactive employee is denied", async () => {
  const own = await users.dev_off.client.rpc("get_my_profile");
  assert.equal(own.error?.code, "42501");
});

test("anonymous callers and private functions are not reachable", async () => {
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });
  const list = await anon.rpc("list_employees");
  assert.ok(list.error, "anon must be rejected");
  const privateFn = await users.pm.client.rpc("require_employee_actor", { p_allowed_roles: ["DEVELOPER"] });
  assert.ok(privateFn.error, "private schema functions are not exposed");
});

test("invalid input is rejected with a client error", async () => {
  const bad = await users.pm.client.rpc("list_employees", { p_page_size: 1000 });
  assert.equal(bad.error?.code, "22023");
  const badRole = await users.pm.client.rpc("list_employees", { p_role: "ADMIN" });
  assert.equal(badRole.error?.code, "22P02");
});
