// Password recovery through the REAL local stack: Auth sends the CYCLO recovery
// email to Mailpit, the link is opened against the running app (production build
// on http://127.0.0.1:3105), and the rendered Server Action form is submitted.
// LOCAL ONLY.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

import { localSql } from "../helpers/local-postgres.mjs";

const url = process.env.API_URL;
const anonKey = process.env.PUBLISHABLE_KEY ?? process.env.ANON_KEY;
const serviceKey = process.env.SECRET_KEY ?? process.env.SERVICE_ROLE_KEY;
const mailpit = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const app = "http://127.0.0.1:3105";
if (!url || !anonKey || !serviceKey) throw new Error("Load `supabase status -o env` output first.");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Refusing to run against a non-local Supabase URL.");

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const run = randomUUID().slice(0, 8);
const users = {};

async function makeUser(key, active = true) {
  const email = `it-rec-${run}-${key}@cyclo.test`;
  const password = randomBytes(18).toString("base64url");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const id = created.data.user.id;
  if (active) {
    const update = await admin.from("profiles").update({ is_active: true, full_name: `Recovery ${key}` }).eq("id", id);
    if (update.error) throw update.error;
  }
  users[key] = { id, email, password };
}

before(async () => {
  const probe = await fetch(`${app}/login`).catch(() => null);
  if (!probe?.ok) throw new Error(`Start the verification app on ${app} first.`);
  await makeUser("active");
  await makeUser("other");
});

after(async () => {
  const ids = Object.values(users).map((u) => u.id);
  for (const { email } of Object.values(users)) await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`, { method: "DELETE" }).catch(() => {});
  if (ids.every((id) => /^[0-9a-f-]{36}$/.test(id))) localSql(`delete from private.employee_audit_log where actor_id in (${ids.map((id) => `'${id}'`).join(",")});`);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
});

// --- helpers ---------------------------------------------------------------
class Jar {
  cookies = new Map();
  header() { return [...this.cookies].map(([n, v]) => `${n}=${v}`).join("; "); }
  store(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim();
      const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim())) || value === "";
      if (expired) this.cookies.delete(name); else this.cookies.set(name, value);
    }
  }
}

async function get(path, jar) {
  const response = await fetch(`${app}${path}`, { headers: jar ? { cookie: jar.header() } : {}, redirect: "manual" });
  jar?.store(response);
  return { status: response.status, location: response.headers.get("location"), body: response.status === 200 ? await response.text() : "" };
}

async function recoveryEmailLink(email) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const list = await (await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    const message = list.messages?.[0];
    if (message) {
      const full = await (await fetch(`${mailpit}/api/v1/message/${message.ID}`)).json();
      const href = /href="([^"]*\/auth\/recovery\?[^"]+)"/.exec(full.HTML)?.[1]?.replaceAll("&amp;", "&");
      return { subject: full.Subject, href };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("recovery email not received");
}

/** Submits the rendered progressive-enhancement Server Action form. */
async function submitResetForm(html, jar, password, confirmation = password) {
  const form = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]).find((t) => t.includes('name="confirmation"'));
  assert.ok(form, "rendered reset form");
  const decode = (v) => v.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
  const data = new FormData();
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const name = input[0].match(/name="([^"]+)"/)?.[1], value = input[0].match(/value="([^"]*)"/)?.[1];
    if (name?.startsWith("$ACTION_")) data.append(decode(name), decode(value ?? ""));
  }
  data.set("password", password);
  data.set("confirmation", confirmation);
  const response = await fetch(`${app}/reset-password`, { method: "POST", headers: { cookie: jar.header(), Origin: app }, body: data, redirect: "manual" });
  jar.store(response);
  return { status: response.status, location: response.headers.get("location"), body: [200].includes(response.status) ? await response.text() : "" };
}

async function canSignIn(email, password) {
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  return !error;
}

// --- tests -----------------------------------------------------------------
/** Submits a rendered progressive-enhancement Server Action form found by a field name. */
async function submitPageForm(path, marker, fields, jar = new Jar()) {
  const page = await get(path, jar);
  assert.equal(page.status, 200, path);
  const form = [...page.body.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]).find((t) => t.includes(marker));
  assert.ok(form, `form with ${marker} on ${path}`);
  const decode = (v) => v.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
  const data = new FormData();
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const name = input[0].match(/name="([^"]+)"/)?.[1], value = input[0].match(/value="([^"]*)"/)?.[1];
    if (name?.startsWith("$ACTION_")) data.append(decode(name), decode(value ?? ""));
  }
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  const response = await fetch(`${app}${path}`, { method: "POST", headers: { cookie: jar.header(), Origin: app }, body: data, redirect: "manual" });
  jar.store(response);
  return { status: response.status, body: response.status === 200 ? await response.text() : "" };
}

const NEUTRAL = "If an account exists for this email, you will receive a password reset link.";

async function mailCount(email) {
  const list = await (await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
  return list.messages_count ?? list.messages?.length ?? 0;
}

test("login page links to Forgot password", async () => {
  const login = await get("/login", null);
  assert.match(login.body, /href="\/forgot-password"/);
});

test("Forgot password: unknown and invalid emails reveal nothing", async () => {
  const unknown = `nobody-${run}@cyclo.test`;
  const result = await submitPageForm("/forgot-password", 'name="email"', { email: unknown });
  assert.equal(result.status, 200);
  assert.ok(result.body.includes(NEUTRAL), "neutral message for an unknown address");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(await mailCount(unknown), 0, "no email for an unknown address");
  const invalid = await submitPageForm("/forgot-password", 'name="email"', { email: "not-an-email" });
  assert.ok(invalid.body.includes("Enter a valid work email address."));
  assert.ok(!invalid.body.includes(NEUTRAL));
});

test("recovery email uses the CYCLO template and links to the recovery callback", async () => {
  const result = await submitPageForm("/forgot-password", 'name="email"', { email: users.active.email });
  assert.equal(result.status, 200);
  assert.ok(result.body.includes(NEUTRAL), "same neutral message for an existing account");
  const { subject, href } = await recoveryEmailLink(users.active.email);
  assert.equal(subject, "Reset your CYCLO password");
  const link = new URL(href);
  assert.equal(link.pathname, "/auth/recovery");
  assert.equal(link.searchParams.get("type"), "recovery");
  assert.match(link.searchParams.get("token_hash"), /^[A-Za-z0-9_-]{20,}$/);
  users.active.link = `${link.pathname}${link.search}`;
});

test("email link → /reset-password → new password → signed out → login with the new password", async () => {
  const jar = new Jar();
  const callback = await get(users.active.link, jar);
  assert.equal(callback.status, 303);
  assert.equal(callback.location, "/reset-password", "host-relative redirect");
  assert.ok(jar.cookies.size > 0, "recovery session cookies set");

  const page = await get("/reset-password", jar);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(users.active.email), "shows the account");
  assert.ok(page.body.includes('name="confirmation"'), "shows the form");

  const mismatch = await submitResetForm(page.body, jar, "correct horse battery staple", "different horse battery");
  assert.ok(mismatch.status === 200 && mismatch.body.includes("Passwords do not match"), `mismatch: ${mismatch.status}`);
  assert.equal(await canSignIn(users.active.email, users.active.password), true, "old password still valid after a rejected attempt");

  const newPassword = `New-${randomBytes(12).toString("base64url")}`;
  const done = await submitResetForm(page.body, jar, newPassword);
  assert.ok([303, 307].includes(done.status), `submit: ${done.status}`);
  assert.equal(done.location, "/login?notice=password_updated");

  assert.equal(await canSignIn(users.active.email, users.active.password), false, "old password rejected");
  assert.equal(await canSignIn(users.active.email, newPassword), true, "new password works");
  const after = await get("/reset-password", jar);
  assert.ok(!after.body.includes('name="confirmation"'), "recovery session revoked (signed out everywhere)");
  const login = await get("/login?notice=password_updated", null);
  assert.ok(login.body.includes("Your password has been updated"), "login shows the success notice");
});

test("a used recovery link cannot be replayed", async () => {
  const replay = await get(users.active.link, new Jar());
  assert.equal(replay.location, "/login?error=recovery_invalid");
  const login = await get(replay.location, null);
  assert.ok(login.body.includes("password-reset link is invalid"));
});

test("a normal password session cannot use the reset page", async () => {
  let jarCookies = [];
  const ssr = createServerClient(url, anonKey, { cookies: { getAll: () => jarCookies, setAll: (c) => { jarCookies = c.filter((x) => x.value); } } });
  assert.equal((await ssr.auth.signInWithPassword({ email: users.other.email, password: users.other.password })).error, null);
  const jar = new Jar();
  for (const { name, value } of jarCookies) jar.cookies.set(name, value);
  const page = await get("/reset-password", jar);
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes('name="confirmation"'), "no form for a password-login session");
  assert.ok(page.body.includes("fresh password-reset link"));
  assert.equal(await canSignIn(users.other.email, users.other.password), true, "password unchanged");
});

test("anonymous visitors and malformed links get no form", async () => {
  const page = await get("/reset-password", null);
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes('name="confirmation"'));
  for (const path of ["/auth/recovery", "/auth/recovery?token_hash=abc&type=recovery", `/auth/recovery?token_hash=${"a".repeat(40)}&type=invite`, "/auth/recovery?code=bad&next=https://evil.test"]) {
    const r = await get(path, null);
    assert.equal(r.location, "/login?error=recovery_invalid", path);
  }
});

test("security headers also cover the recovery routes", async () => {
  for (const path of ["/reset-password", "/auth/recovery?code=x"]) {
    const response = await fetch(`${app}${path}`, { redirect: "manual" });
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, path);
  }
});

test("an expired recovery link is rejected", async () => {
  const link = await admin.auth.admin.generateLink({ type: "recovery", email: users.other.email });
  assert.equal(link.error, null);
  // Local test fixture only: age the recovery request beyond the Auth expiry.
  assert.match(users.other.id, /^[0-9a-f-]{36}$/);
  const aged = localSql(`update auth.users set recovery_sent_at = now() - interval '2 hours' where id = '${users.other.id}';`);
  assert.equal(aged.code, 0, aged.stderr);
  const r = await get(`/auth/recovery?token_hash=${link.data.properties.hashed_token}&type=recovery`, new Jar());
  assert.equal(r.location, "/login?error=recovery_invalid");
  assert.equal(await canSignIn(users.other.email, users.other.password), true, "password unchanged");
});

test("the reset page offers a new link when the session is not a recovery session", async () => {
  const page = await get("/reset-password", null);
  assert.match(page.body, /href="\/forgot-password"/);
});
