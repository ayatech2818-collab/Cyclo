// Phase 6 integration: own profile and avatars through the REAL local Supabase
// HTTP stack (Auth + PostgREST + Storage). LOCAL ONLY: refuses non-loopback URLs.
//
//   node --env-file=.env.supabase-local --test tests/integration/profile.local.mjs
//
// Creates throwaway PM / developer users, removes their objects, audit rows and
// accounts afterwards.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createClient } from "@supabase/supabase-js";

import { localSql } from "../helpers/local-postgres.mjs";

const url = process.env.API_URL;
const anonKey = process.env.PUBLISHABLE_KEY ?? process.env.ANON_KEY;
const serviceKey = process.env.SECRET_KEY ?? process.env.SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) throw new Error("Load `supabase status -o env` output first.");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Refusing to run against a non-local Supabase URL.");

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const run = randomUUID().slice(0, 8);
const users = {};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(1)]);
const objectPath = (id, ext = "png") => `${id}/${randomUUID()}.${ext}`;

async function makeUser(key, role, isActive = true) {
  const email = `it6-${run}-${key}@cyclo.test`;
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const id = data.user.id;
  const update = await admin.from("profiles").update({ role, is_active: true, full_name: `IT6 ${key}` }).eq("id", id);
  if (update.error) throw update.error;
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  if (!isActive) {
    const off = await admin.from("profiles").update({ is_active: false }).eq("id", id);
    if (off.error) throw off.error;
  }
  users[key] = { id, client };
}

before(async () => {
  await makeUser("pm", "PROJECT_MANAGER");
  await makeUser("dev", "DEVELOPER");
  await makeUser("dev2", "DEVELOPER");
  await makeUser("off", "DEVELOPER", false);
});

after(async () => {
  const ids = Object.values(users).map((u) => u.id);
  for (const { id, client } of Object.values(users)) {
    const { data } = await admin.storage.from("avatars").list(id);
    if (data?.length) await admin.storage.from("avatars").remove(data.map((o) => `${id}/${o.name}`));
    await client.auth.signOut();
  }
  // Disposable fixture audits only; ordinary roles have no audit DELETE privilege.
  if (ids.every((id) => /^[0-9a-f-]{36}$/.test(id))) {
    localSql(`delete from private.employee_audit_log where actor_id in (${ids.map((id) => `'${id}'`).join(",")});`);
  }
  for (const id of ids) await admin.auth.admin.deleteUser(id);
});

test("upload, attach, sign, replace and remove a photo through Storage", async () => {
  const { client, id } = users.dev;
  const first = objectPath(id);
  const up = await client.storage.from("avatars").upload(first, PNG, { contentType: "image/png", upsert: false });
  assert.equal(up.error, null);
  const attached = await client.rpc("set_my_avatar_image", { p_path: first });
  assert.equal(attached.error, null);
  assert.equal(attached.data[0].avatar_kind, "image");

  const signed = await client.storage.from("avatars").createSignedUrl(first, 60);
  assert.equal(signed.error, null);
  const download = await fetch(signed.data.signedUrl);
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), PNG);

  const second = objectPath(id, "webp");
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 1, 1, 1, 0x57, 0x45, 0x42, 0x50, ...new Array(32).fill(2)]);
  assert.equal((await client.storage.from("avatars").upload(second, webp, { contentType: "image/webp" })).error, null);
  const replaced = await client.rpc("set_my_avatar_image", { p_path: second });
  assert.equal(replaced.data[0].previous_path, first);
  assert.equal((await client.storage.from("avatars").remove([first])).error, null);

  const removed = await client.rpc("remove_my_avatar_image");
  assert.equal(removed.data[0].avatar_kind, "default");
  assert.equal(removed.data[0].previous_path, second);
  assert.equal((await client.storage.from("avatars").remove([second])).error, null);
  const { data: left } = await admin.storage.from("avatars").list(id);
  assert.equal(left.length, 0, "no objects left behind");
});

test("Storage rejects other folders, overwrites, wrong types and oversized files", async () => {
  const { client, id } = users.dev;
  const other = await client.storage.from("avatars").upload(objectPath(users.dev2.id), PNG, { contentType: "image/png" });
  assert.ok(other.error, "cannot upload into another employee's folder");
  const name = await client.storage.from("avatars").upload(`${id}/avatar.png`, PNG, { contentType: "image/png" });
  assert.ok(name.error, "arbitrary names rejected");
  const svg = await client.storage.from("avatars").upload(objectPath(id), new TextEncoder().encode("<svg/>"), { contentType: "image/svg+xml" });
  assert.ok(svg.error, "SVG MIME type rejected by the bucket");
  const big = await client.storage.from("avatars").upload(objectPath(id), new Uint8Array(2 * 1024 * 1024 + 1), { contentType: "image/png" });
  assert.ok(big.error, "files over 2 MiB rejected by the bucket");

  const path = objectPath(id);
  assert.equal((await client.storage.from("avatars").upload(path, PNG, { contentType: "image/png" })).error, null);
  const overwrite = await client.storage.from("avatars").upload(path, PNG, { contentType: "image/png", upsert: true });
  assert.ok(overwrite.error, "no UPDATE policy, so upsert cannot overwrite");
  await client.storage.from("avatars").remove([path]);
});

test("photos are visible to self and directory roles only; others cannot delete them", async () => {
  const owner = users.dev;
  const path = objectPath(owner.id);
  assert.equal((await owner.client.storage.from("avatars").upload(path, PNG, { contentType: "image/png" })).error, null);
  assert.equal((await owner.client.rpc("set_my_avatar_image", { p_path: path })).error, null);

  assert.equal((await users.pm.client.storage.from("avatars").createSignedUrl(path, 60)).error, null, "project manager can view");
  assert.ok((await users.dev2.client.storage.from("avatars").createSignedUrl(path, 60)).error, "other developer cannot view");
  assert.ok((await users.off.client.storage.from("avatars").createSignedUrl(path, 60)).error, "inactive employee cannot view");
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });
  assert.ok((await anon.storage.from("avatars").createSignedUrl(path, 60)).error, "anonymous cannot view");
  const publicUrl = anon.storage.from("avatars").getPublicUrl(path).data.publicUrl;
  assert.notEqual((await fetch(publicUrl)).status, 200, "bucket is not public");

  await users.dev2.client.storage.from("avatars").remove([path]);
  const { data } = await admin.storage.from("avatars").list(owner.id);
  assert.ok(data.some((o) => path.endsWith(o.name)), "another employee's delete has no effect");

  const pmView = await users.pm.client.rpc("get_employee_avatars", { p_employee_ids: [owner.id, users.dev2.id] });
  assert.equal(pmView.data.length, 2);
  const devView = await users.dev2.client.rpc("get_employee_avatars", { p_employee_ids: [owner.id, users.dev2.id] });
  assert.deepEqual(devView.data.map((r) => r.id), [users.dev2.id], "developers only see their own avatar state");

  await owner.client.rpc("remove_my_avatar_image");
  await owner.client.storage.from("avatars").remove([path]);
});

test("emoji, icon and initials selections; protected fields stay unchanged", async () => {
  const { client, id } = users.dev;
  for (const [kind, symbol] of [["emoji", "rocket"], ["icon", "terminal"], ["initials", null]]) {
    const result = await client.rpc("set_my_avatar", symbol ? { p_kind: kind, p_symbol: symbol } : { p_kind: kind });
    assert.equal(result.error, null, `${kind} accepted`);
  }
  for (const [kind, symbol] of [["emoji", "<script>"], ["icon", "javascript:alert(1)"], ["image", null]]) {
    const result = await client.rpc("set_my_avatar", { p_kind: kind, p_symbol: symbol });
    assert.equal(result.error?.code, "22023", `${kind}/${symbol} rejected`);
  }
  assert.equal((await client.rpc("update_my_profile", { p_full_name: "  IT6 Renamed  " })).error, null);

  const direct = await client.from("profiles").update({ avatar_kind: "emoji", avatar_symbol: "fox" }).eq("id", id);
  assert.ok(direct.error, "avatar columns cannot be written directly");
  const escalate = await client.from("profiles").update({ role: "SUPER_ADMIN", is_active: true, is_git_organizer: true }).eq("id", id);
  assert.ok(escalate.error, "role, status and Git Organizer cannot be self-assigned");
  const directName = await client.from("profiles").update({ full_name: "Direct" }).eq("id", id);
  assert.equal(directName.error?.code, "42501", "direct name update revoked; only the audited RPC works");
  const directUrl = await client.from("profiles").update({ avatar_url: "https://evil.test/x.png" }).eq("id", id);
  assert.equal(directUrl.error?.code, "42501", "direct avatar_url update revoked");

  const { data } = await admin.from("profiles").select("full_name, role, is_active, is_git_organizer, avatar_kind").eq("id", id).single();
  assert.deepEqual(data, { full_name: "IT6 Renamed", role: "DEVELOPER", is_active: true, is_git_organizer: false, avatar_kind: "initials" });
});

test("inactive employees cannot change their profile or upload", async () => {
  const { client, id } = users.off;
  assert.equal((await client.rpc("set_my_avatar", { p_kind: "emoji", p_symbol: "fox" })).error?.code, "42501");
  assert.equal((await client.rpc("update_my_profile", { p_full_name: "Nope" })).error?.code, "42501");
  assert.ok((await client.storage.from("avatars").upload(objectPath(id), PNG, { contentType: "image/png" })).error);
});
