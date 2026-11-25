import assert from "node:assert/strict";
import test from "node:test";

import { loadTsModule } from "./helpers/load-ts-module.mjs";

const origins = loadTsModule("src/lib/supabase/invitation-origins.ts");
const { resolveInvitationTargets, isAcceptableSecretKey } = origins;
const plain = (value) => JSON.parse(JSON.stringify(value));

const HOSTED = "https://abcdefghijklmnopqrst.supabase.co";
const APP = "https://cyclo.ayatech.example";
const rejects = (supabase, app, why) => assert.throws(() => resolveInvitationTargets(supabase, app), { name: "InvitationConfigError" }, why);

test("local development keeps working as before", () => {
  assert.deepEqual(plain(resolveInvitationTargets("http://127.0.0.1:54321", undefined)), {
    mode: "local", supabaseOrigin: "http://127.0.0.1:54321", callbackUrl: "http://127.0.0.1:3000/auth/confirm",
  }, "CYCLO_APP_URL still defaults locally");
  for (const [app, callback] of [
    ["http://127.0.0.1:3105", "http://127.0.0.1:3105/auth/confirm"],
    ["http://localhost:3000/", "http://localhost:3000/auth/confirm"],
    ["http://[::1]:3000", "http://[::1]:3000/auth/confirm"],
    ["https://localhost:3443", "https://localhost:3443/auth/confirm"],
  ]) {
    assert.equal(resolveInvitationTargets("http://localhost:54321", app).callbackUrl, callback, app);
  }
});

test("production accepts only a hosted Supabase project and an explicit https origin", () => {
  assert.deepEqual(plain(resolveInvitationTargets(HOSTED, APP)), {
    mode: "production", supabaseOrigin: HOSTED, callbackUrl: `${APP}/auth/confirm`,
  });
  assert.equal(resolveInvitationTargets(`${HOSTED}/`, `${APP}/`).callbackUrl, `${APP}/auth/confirm`, "trailing slash is normalised");
  assert.equal(resolveInvitationTargets(HOSTED, "https://cyclo.example.com:443").callbackUrl, "https://cyclo.example.com/auth/confirm", "explicit default port is the default port");
});

test("hosted Supabase URL: arbitrary hosts, http, ports and extras are rejected", () => {
  for (const url of [
    "http://abcdefghijklmnopqrst.supabase.co",
    "https://abcdefghijklmnopqrst.supabase.co:8443",
    "https://abcdefghijklmnopqrst.supabase.co/rest/v1",
    "https://abcdefghijklmnopqrst.supabase.co?x=1",
    "https://user:pw@abcdefghijklmnopqrst.supabase.co",
    "https://evil.test",
    "https://abcdefghijklmnopqrst.supabase.co.evil.test",
    "https://evil.supabase.co",
    "https://abcdefghijklmnopqrst.supabase.com",
    "https://x.abcdefghijklmnopqrst.supabase.co",
    "ftp://abcdefghijklmnopqrst.supabase.co",
    "not a url",
    "",
    undefined,
  ]) rejects(url, APP, String(url));
});

test("production app origin: http, ports, IPs, paths, credentials and missing values are rejected", () => {
  for (const app of [
    undefined,
    "",
    "http://cyclo.ayatech.example",
    "https://cyclo.ayatech.example:8443",
    "https://cyclo.ayatech.example/app",
    "https://cyclo.ayatech.example/auth/confirm",
    "https://cyclo.ayatech.example?next=/",
    "https://cyclo.ayatech.example#x",
    "https://user:pw@cyclo.ayatech.example",
    "https://203.0.113.10",
    "https://[2001:db8::1]",
    "https://intranet",
    "javascript:alert(1)",
    "https://cyclo.ayatech.example\\evil",
    " https://cyclo.ayatech.example",
  ]) rejects(HOSTED, app, String(app));
});

test("mixed pairings are rejected in both directions", () => {
  rejects(HOSTED, "http://127.0.0.1:3000", "hosted project must not email local links");
  rejects(HOSTED, "https://localhost", "hosted project must not email loopback links even over https");
  rejects("http://127.0.0.1:54321", APP, "local project must not email production links");
  rejects("http://127.0.0.1:54321", "http://192.168.1.10:3000", "local project must not email LAN links");
});

test("configuration errors never echo the configured values", () => {
  const secretish = "https://user:hunter2@evil.test/path?token=abc";
  for (const [supabase, app] of [[secretish, APP], [HOSTED, secretish]]) {
    try {
      resolveInvitationTargets(supabase, app);
      assert.fail("expected rejection");
    } catch (error) {
      assert.doesNotMatch(error.message, /hunter2|evil\.test|token=abc/);
    }
  }
});

test("secret keys: modern secret keys everywhere, legacy JWTs only locally", () => {
  assert.equal(isAcceptableSecretKey("sb_secret_abcdefgh12345", "production"), true);
  assert.equal(isAcceptableSecretKey("sb_secret_abcdefgh12345", "local"), true);
  assert.equal(isAcceptableSecretKey("aaa.bbb.ccc", "local"), true);
  assert.equal(isAcceptableSecretKey("aaa.bbb.ccc", "production"), false);
  for (const value of [undefined, "", "sb_publishable_abcdefgh123", "sb_secret_", "plain-text"]) {
    assert.equal(isAcceptableSecretKey(value, "production"), false, String(value));
  }
});

// ---------------------------------------------------------------------------
// admin.server.ts wiring
// ---------------------------------------------------------------------------
function adminModule(env) {
  const created = [];
  const mod = loadTsModule("src/lib/supabase/admin.server.ts", {
    "server-only": {},
    "./env": { getSupabaseEnv: () => ({ url: env.url, publishableKey: "pk" }) },
    "@supabase/supabase-js": { createClient: (...args) => { created.push(args); return { auth: {} }; } },
  });
  const saved = { secret: process.env.SUPABASE_SECRET_KEY, app: process.env.CYCLO_APP_URL };
  const run = (fn) => {
    process.env.SUPABASE_SECRET_KEY = env.secret ?? "";
    if (env.app === undefined) delete process.env.CYCLO_APP_URL; else process.env.CYCLO_APP_URL = env.app;
    try { return fn(); } finally {
      if (saved.secret === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = saved.secret;
      if (saved.app === undefined) delete process.env.CYCLO_APP_URL; else process.env.CYCLO_APP_URL = saved.app;
    }
  };
  return { mod, created, run };
}

test("Admin client connects only to the validated project and builds the exact callback", () => {
  const prod = adminModule({ url: HOSTED, app: APP, secret: "sb_secret_abcdefgh12345" });
  prod.run(() => prod.mod.createAuthAdminClient());
  assert.equal(prod.created[0][0], HOSTED);
  assert.equal(prod.created[0][2].auth.persistSession, false);
  assert.equal(prod.run(() => prod.mod.invitationCallbackUrl()), `${APP}/auth/confirm`);

  const local = adminModule({ url: "http://127.0.0.1:54321", app: "http://127.0.0.1:3105", secret: "aaa.bbb.ccc" });
  local.run(() => local.mod.createAuthAdminClient());
  assert.equal(local.created[0][0], "http://127.0.0.1:54321");
  assert.equal(local.run(() => local.mod.invitationCallbackUrl()), "http://127.0.0.1:3105/auth/confirm");
});

test("Admin client is never created for rejected configuration", () => {
  for (const env of [
    { url: "https://evil.test", app: APP, secret: "sb_secret_abcdefgh12345" },
    { url: HOSTED, app: "http://cyclo.ayatech.example", secret: "sb_secret_abcdefgh12345" },
    { url: HOSTED, app: undefined, secret: "sb_secret_abcdefgh12345" },
    { url: HOSTED, app: APP, secret: "aaa.bbb.ccc" },
    { url: HOSTED, app: APP, secret: "" },
  ]) {
    const { mod, created, run } = adminModule(env);
    assert.throws(() => run(() => mod.createAuthAdminClient()), (error) => error instanceof Error && !["ReferenceError", "TypeError"].includes(error.name) && /SUPABASE|CYCLO_APP_URL/.test(error.message), JSON.stringify({ ...env, secret: env.secret ? "set" : "empty" }));
    assert.equal(created.length, 0);
  }
});
