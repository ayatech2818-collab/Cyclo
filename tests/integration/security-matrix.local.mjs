// Phase 7: route × role access matrix against the RUNNING app (production build
// on http://127.0.0.1:3105, started with `node --env-file=.env.supabase-local
// scripts/dev-local.mjs 3105 --prod`). LOCAL ONLY.
//
// Sessions are created exactly as the browser would hold them: @supabase/ssr
// writes the auth cookies, which are then sent to the app as a Cookie header.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const url = process.env.API_URL;
const anonKey = process.env.PUBLISHABLE_KEY ?? process.env.ANON_KEY;
const serviceKey = process.env.SECRET_KEY ?? process.env.SERVICE_ROLE_KEY;
const app = "http://127.0.0.1:3105";
if (!url || !anonKey || !serviceKey) throw new Error("Load `supabase status -o env` output first.");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Refusing to run against a non-local Supabase URL.");

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const run = randomUUID().slice(0, 8);
const users = {};

async function makeUser(key, role, isActive, { uninvited = false } = {}) {
  const email = `it7-${run}-${key}@cyclo.test`;
  const password = randomBytes(24).toString("base64url");
  // Metadata must never grant a role or activate the account.
  const created = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { role: "SUPER_ADMIN", is_active: true }, app_metadata: { role: "SUPER_ADMIN" },
  });
  if (created.error) throw created.error;
  const id = created.data.user.id;
  if (!uninvited) {
    const update = await admin.from("profiles").update({ role, is_active: true, full_name: `IT7 ${key} ${run}` }).eq("id", id);
    if (update.error) throw update.error;
  }

  let jar = [];
  const ssr = createServerClient(url, anonKey, {
    cookies: { getAll: () => jar, setAll: (cookies) => { jar = cookies.filter((c) => c.value).map(({ name, value }) => ({ name, value })); } },
  });
  const signIn = await ssr.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  if (!isActive && !uninvited) {
    const off = await admin.from("profiles").update({ is_active: false }).eq("id", id);
    if (off.error) throw off.error;
  }
  users[key] = { id, role, ssr, cookie: jar.map((c) => `${c.name}=${c.value}`).join("; ") };
}

before(async () => {
  const probe = await fetch(`${app}/login`).catch(() => null);
  if (!probe?.ok) throw new Error(`Start the verification app on ${app} first.`);
  await makeUser("sa", "SUPER_ADMIN", true);
  await makeUser("pm", "PROJECT_MANAGER", true);
  await makeUser("dev", "DEVELOPER", true);
  await makeUser("off", "DEVELOPER", false);
  // Created like a Dashboard/Admin-API account with no database invitation.
  await makeUser("uninvited", "DEVELOPER", false, { uninvited: true });
});

after(async () => {
  for (const { id, role } of Object.values(users)) {
    // A Super Admin fixture must be demoted before deletion (last-admin protection).
    if (role === "SUPER_ADMIN") await admin.from("profiles").update({ role: "DEVELOPER" }).eq("id", id);
    await admin.auth.admin.deleteUser(id);
  }
});

async function get(path, who) {
  const headers = who ? { cookie: users[who].cookie } : {};
  const response = await fetch(`${app}${path}`, { headers, redirect: "manual" });
  const body = response.status === 200 ? await response.text() : "";
  return { status: response.status, location: response.headers.get("location"), body };
}

const isLoginRedirect = (r) => [303, 307].includes(r.status) && /\/login(\?|$)/.test(r.location ?? "");
// The not-found component ships in every page's payload, so "contains Page not
// found" proves nothing. A hidden page is proven by a 404, or by a streamed 200
// that lacks the page's own content. (Phase 7 findings L1/L2: some role-hidden
// pages answer 200 with a specific title; no data is exposed.)
const isHidden = (r, marker) => r.status === 404 || (r.status === 200 && !r.body.includes(marker));

const devName = () => `IT7 dev ${run}`;
const routes = () => ({
  dashboard: "/dashboard",
  profile: "/profile",
  directory: `/employees?q=${run}`,
  detail: `/employees/${users.dev.id}`,
  invitations: "/employees/invitations",
});
const markers = () => ({ directory: devName(), detail: devName(), invitations: "Recent invitations" });

test("anonymous visitors are sent to sign in from every protected page", async () => {
  for (const [name, path] of Object.entries(routes())) {
    const r = await get(path, null);
    assert.ok(isLoginRedirect(r), `${name}: ${r.status} ${r.location}`);
  }
  assert.equal((await get("/login", null)).status, 200);
});

test("inactive employees keep no access even with a valid session", async () => {
  for (const [name, path] of Object.entries(routes())) {
    const r = await get(path, "off");
    assert.ok(isLoginRedirect(r), `${name}: ${r.status} ${r.location}`);
    assert.match(r.location, /error=denied/, `${name} reports denied`);
  }
});

test("developer: dashboard and own profile only; employee pages are not disclosed", async () => {
  const r = routes();
  for (const name of ["dashboard", "profile"]) assert.equal((await get(r[name], "dev")).status, 200, name);
  for (const name of ["directory", "detail", "invitations"]) {
    const page = await get(r[name], "dev");
    assert.ok(isHidden(page, markers()[name]), `${name} hidden (${page.status})`);
  }
  const profile = await get(r.profile, "dev");
  assert.ok(profile.body.includes(devName()), "own profile rendered");
  assert.ok(!profile.body.includes('href="/employees"'), "no directory link for developers");
});

test("project manager: directory and detail without admin fields; no invitations", async () => {
  const r = routes();
  for (const name of ["dashboard", "profile", "directory", "detail"]) assert.equal((await get(r[name], "pm")).status, 200, name);
  assert.ok((await get(r.directory, "pm")).body.includes(devName()), "PM sees the directory listing");
  const detail = await get(r.detail, "pm");
  assert.ok(detail.body.includes(devName()), "PM sees directory detail");
  for (const adminOnly of ["Visible to Super Admins only", "Git Organizer", "Invited by", "Onboarded"]) {
    assert.ok(!detail.body.includes(adminOnly), `PM detail leaks "${adminOnly}"`);
  }
  const invitations = await get(r.invitations, "pm");
  assert.ok(isHidden(invitations, markers().invitations), `invitations hidden from PM (${invitations.status})`);
  assert.ok(!invitations.body.includes("Invite employee"), "PM never receives the invite form");
});

test("super admin: every page, including administration and invitations", async () => {
  const r = routes();
  for (const [name, path] of Object.entries(r)) assert.equal((await get(path, "sa")).status, 200, name);
  assert.ok((await get(r.directory, "sa")).body.includes(devName()));
  assert.ok((await get(r.detail, "sa")).body.includes("Visible to Super Admins only"));
  assert.ok((await get(r.invitations, "sa")).body.includes(markers().invitations));
});

test("signed-in employees are redirected away from login; unknown and malformed ids reveal nothing", async () => {
  const login = await get("/login", "dev");
  assert.ok([303, 307].includes(login.status) && /\/dashboard$/.test(login.location ?? ""), `${login.status} ${login.location}`);
  // Phase 7 finding L2: for authorized viewers both malformed and unknown ids are
  // resolved below the loading boundary (streamed 200). They must show no data.
  for (const id of ["not-a-uuid", randomUUID()]) {
    const r = await get(`/employees/${id}`, "sa");
    assert.ok(isHidden(r, "Visible to Super Admins only"), `${id}: ${r.status}`);
  }
  assert.equal((await get("/employees/not-a-uuid", "dev")).status, 404, "unauthorized role gets a real 404");
});

test("confirm callback never follows external redirects and keeps the browser host", async () => {
  const r = await fetch(`${app}/auth/confirm?token_hash=${"a".repeat(40)}&type=invite&next=https://evil.test`, { redirect: "manual" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/login?error=invitation_invalid");
});

// ---------------------------------------------------------------------------
// Phase 7 fix H1: uninvited accounts
// ---------------------------------------------------------------------------
test("an uninvited account is created inactive and cannot use CYCLO", async () => {
  const { data } = await admin.from("profiles").select("role, is_active, requires_onboarding").eq("id", users.uninvited.id).single();
  assert.deepEqual(data, { role: "DEVELOPER", is_active: false, requires_onboarding: false }, "metadata ignored; inactive default profile");
  for (const [name, path] of Object.entries(routes())) {
    const r = await get(path, "uninvited");
    assert.ok(isLoginRedirect(r) && /error=denied/.test(r.location), `${name}: ${r.status} ${r.location}`);
  }
  for (const [fn, args] of [["get_my_profile", {}], ["list_employees", {}], ["update_my_profile", { p_full_name: "x" }], ["set_my_avatar", { p_kind: "initials" }]]) {
    const result = await users.uninvited.ssr.rpc(fn, args);
    assert.equal(result.error?.code, "42501", `${fn} denied`);
  }
  const self = await users.uninvited.ssr.from("profiles").update({ is_active: true }).eq("id", users.uninvited.id);
  assert.equal(self.error?.code, "42501", "cannot activate itself");
});

test("existing active employees keep access after the H1 change", async () => {
  for (const key of ["sa", "pm", "dev"]) assert.equal((await get("/dashboard", key)).status, 200, key);
});

// ---------------------------------------------------------------------------
// Phase 7 fix M1: security headers on every kind of response
// ---------------------------------------------------------------------------
const expectedHeaders = {
  "content-security-policy": "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "permissions-policy": /camera=\(\), microphone=\(\), geolocation=\(\)/,
};

test("security headers are present on pages, redirects, route handlers, 404s and static assets", async () => {
  const login = await fetch(`${app}/login`);
  const html = await login.text();
  const asset = /\/_next\/static\/[^"']+\.js/.exec(html)?.[0];
  assert.ok(asset, "found a static asset");
  const cases = {
    "page (anonymous)": { path: "/login" },
    "page (signed in)": { path: "/profile", who: "dev" },
    "proxy redirect": { path: "/dashboard" },
    "auth callback route": { path: `/auth/confirm?token_hash=${"a".repeat(40)}&type=invite` },
    "role-hidden page": { path: "/employees", who: "dev" },
    "static asset": { path: asset },
  };
  for (const [name, { path, who }] of Object.entries(cases)) {
    const r = await fetch(`${app}${path}`, { headers: who ? { cookie: users[who].cookie } : {}, redirect: "manual" });
    for (const [header, expected] of Object.entries(expectedHeaders)) {
      const value = r.headers.get(header);
      if (expected instanceof RegExp) assert.match(value ?? "", expected, `${name}: ${header}`);
      else assert.equal(value, expected, `${name}: ${header}`);
    }
    assert.ok(r.headers.get("referrer-policy"), `${name}: referrer-policy`);
    assert.equal(r.headers.get("x-powered-by"), null, `${name}: x-powered-by removed`);
  }
  assert.equal(login.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  const callback = await fetch(`${app}/auth/confirm?token_hash=${"a".repeat(40)}&type=invite`, { redirect: "manual" });
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer", "callback keeps its stricter no-referrer");
});

test("signed avatar URLs are served by Supabase Storage, unaffected by app headers", async () => {
  const path = `${users.dev.id}/${randomUUID()}.png`;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  assert.equal((await users.dev.ssr.storage.from("avatars").upload(path, png, { contentType: "image/png" })).error, null);
  try {
    const signed = await users.dev.ssr.storage.from("avatars").createSignedUrl(path, 60);
    assert.equal(signed.error, null);
    const image = await fetch(signed.data.signedUrl);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("x-frame-options"), null, "Storage responses are not altered by the app");
  } finally {
    await users.dev.ssr.storage.from("avatars").remove([path]);
  }
});
