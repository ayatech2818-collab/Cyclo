import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { loadTsModule } from "./helpers/load-ts-module.mjs";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const recovery = loadTsModule("src/features/auth/recovery.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const params = (query) => new URLSearchParams(query);
const HASH = "a".repeat(56);
const NOW = 1_800_000_000;

// ---------------------------------------------------------------------------
// Callback parsing
// ---------------------------------------------------------------------------
test("recovery callback accepts a recovery token hash or a PKCE code only", () => {
  assert.deepEqual(plain(recovery.parseRecoveryCallback(params(`token_hash=${HASH}&type=recovery`))), { kind: "token_hash", tokenHash: HASH });
  assert.deepEqual(plain(recovery.parseRecoveryCallback(params("code=0b5f6a43-1c2d-4e5f-8a9b-0c1d2e3f4a5b"))), { kind: "code", code: "0b5f6a43-1c2d-4e5f-8a9b-0c1d2e3f4a5b" });
  assert.equal(recovery.parseRecoveryCallback(params("code=0b5f6a43-1c2d-4e5f&type=recovery")).kind, "code");
  for (const query of [
    "",
    `token_hash=${HASH}`,
    `token_hash=${HASH}&type=invite`,
    `token_hash=${HASH}&type=email`,
    `token_hash=${HASH}&type=recovery&type=recovery`,
    `token_hash=${HASH}&token_hash=${HASH}&type=recovery`,
    `token_hash=${HASH}&type=recovery&code=abcdefgh123`,
    "token_hash=short&type=recovery",
    `token_hash=${"a".repeat(40)}%3Cscript%3E&type=recovery`,
    "code=abc",
    "code=abcdefgh123&type=invite",
    "code=abcdefgh123&code=abcdefgh456",
    "code=../../evil%2Fpath",
  ]) assert.equal(recovery.parseRecoveryCallback(params(query)), null, query);
});

// ---------------------------------------------------------------------------
// Recovery session window
// ---------------------------------------------------------------------------
test("only a fresh email-link session can use the reset page", () => {
  const claims = (method, age) => ({ amr: [{ method, timestamp: NOW - age }] });
  assert.equal(recovery.isRecentEmailLinkSession(claims("otp", 0), NOW), true);
  assert.equal(recovery.isRecentEmailLinkSession(claims("recovery", 60), NOW), true);
  assert.equal(recovery.isRecentEmailLinkSession(claims("otp", recovery.RECOVERY_WINDOW_SECONDS), NOW), true);
  assert.equal(recovery.isRecentEmailLinkSession(claims("otp", recovery.RECOVERY_WINDOW_SECONDS + 1), NOW), false, "expired window");
  assert.equal(recovery.isRecentEmailLinkSession(claims("password", 0), NOW), false, "password login");
  assert.equal(recovery.isRecentEmailLinkSession(claims("oauth", 0), NOW), false);
  assert.equal(recovery.isRecentEmailLinkSession(claims("otp", -3600), NOW), false, "future timestamp");
  assert.equal(recovery.isRecentEmailLinkSession({ amr: [{ method: "password", timestamp: NOW - 5 }, { method: "otp", timestamp: NOW - 5 }] }, NOW), true);
  for (const value of [null, undefined, {}, { amr: "otp" }, { amr: [{ method: "otp" }] }, { amr: [{ method: "otp", timestamp: String(NOW) }] }]) {
    assert.equal(recovery.isRecentEmailLinkSession(value, NOW), false, JSON.stringify(value));
  }
});

test("Auth password errors are mapped to safe messages", () => {
  assert.match(recovery.passwordUpdateError({ code: "same_password" }), /different/);
  assert.match(recovery.passwordUpdateError({ code: "weak_password" }), /too weak/);
  assert.match(recovery.passwordUpdateError({ code: "session_not_found" }), /expired/);
  assert.match(recovery.passwordUpdateError({ status: 429 }), /Too many/);
  const generic = recovery.passwordUpdateError({ code: "unexpected_failure", message: "pq: relation auth.secret does not exist" });
  assert.equal(generic, "The password could not be updated. Please try again.");
});

// ---------------------------------------------------------------------------
// /auth/recovery route
// ---------------------------------------------------------------------------
function recoveryRoute({ verifyError = null, exchangeError = null } = {}) {
  const calls = [];
  const route = loadTsModule("src/app/auth/recovery/route.ts", {
    "@/lib/supabase/server": {
      createClient: async () => ({
        auth: {
          verifyOtp: async (args) => { calls.push(["verify", args]); return { error: verifyError }; },
          exchangeCodeForSession: async (code) => { calls.push(["exchange", code]); return { error: exchangeError }; },
        },
      }),
    },
  });
  const get = (query) => {
    const url = new URL(`http://127.0.0.1:3000/auth/recovery?${query}`);
    // next dev reports request.url as localhost; the redirect must stay host-relative.
    return route.GET({ nextUrl: url, url: url.href.replace("127.0.0.1", "localhost") });
  };
  return { get, calls };
}

test("recovery callback verifies the token hash and opens the reset page on the same host", async () => {
  const { get, calls } = recoveryRoute();
  const response = await get(`token_hash=${HASH}&type=recovery&next=https://evil.test`);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/reset-password");
  assert.deepEqual(plain(calls), [["verify", { token_hash: HASH, type: "recovery" }]]);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("recovery callback exchanges a PKCE code", async () => {
  const { get, calls } = recoveryRoute();
  const response = await get("code=0b5f6a43-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
  assert.equal(response.headers.get("location"), "/reset-password");
  assert.deepEqual(plain(calls), [["exchange", "0b5f6a43-1c2d-4e5f-8a9b-0c1d2e3f4a5b"]]);
});

test("invalid, expired or replayed recovery links go to login without calling Auth for malformed input", async () => {
  const malformed = recoveryRoute();
  for (const query of [`token_hash=${HASH}&type=invite`, "code=x", ""]) {
    assert.equal((await malformed.get(query)).headers.get("location"), "/login?error=recovery_invalid", query);
  }
  assert.equal(malformed.calls.length, 0);
  const expired = recoveryRoute({ verifyError: { code: "otp_expired" } });
  assert.equal((await expired.get(`token_hash=${HASH}&type=recovery`)).headers.get("location"), "/login?error=recovery_invalid");
  const badCode = recoveryRoute({ exchangeError: { code: "flow_state_not_found" } });
  assert.equal((await badCode.get("code=0b5f6a43-1c2d-4e5f-8a9b")).headers.get("location"), "/login?error=recovery_invalid");
});

// ---------------------------------------------------------------------------
// resetPassword Server Action
// ---------------------------------------------------------------------------
function resetAction({ session = true, updateError = null, globalSignOutError = null } = {}) {
  const calls = [];
  const client = {
    auth: {
      updateUser: async (args) => { calls.push(["update", args]); return { error: updateError }; },
      signOut: async (args) => { calls.push(["signOut", args]); return { error: args.scope === "global" ? globalSignOutError : null }; },
    },
  };
  const mod = loadTsModule("src/features/auth/recovery-actions.ts", {
    "@/lib/supabase/server": { createClient: async () => assert.fail("reset must use the recovery session client") },
    "./recovery.server": { getRecoverySession: async () => (session ? { client, email: "admin@cyclo.test" } : null), recoveryRedirectUrl: () => null },
    "next/navigation": { redirect(path) { throw Object.assign(new Error("redirect"), { path }); } },
  });
  const form = (password, confirmation = password) => { const data = new FormData(); data.set("password", password); data.set("confirmation", confirmation); return data; };
  return { mod, calls, form };
}

test("a valid new password is saved, every session is revoked and the user goes to login", async () => {
  const { mod, calls, form } = resetAction();
  await assert.rejects(mod.resetPassword({ error: null }, form("correct horse battery")), { path: "/login?notice=password_updated" });
  assert.deepEqual(plain(calls), [["update", { password: "correct horse battery" }], ["signOut", { scope: "global" }]]);
});

test("global sign-out failure still clears the local session", async () => {
  const { mod, calls, form } = resetAction({ globalSignOutError: { message: "network" } });
  await assert.rejects(mod.resetPassword({ error: null }, form("correct horse battery")), { path: "/login?notice=password_updated" });
  assert.deepEqual(plain(calls.slice(1)), [["signOut", { scope: "global" }], ["signOut", { scope: "local" }]]);
});

test("reset is refused without a fresh recovery session, and invalid passwords never reach Auth", async () => {
  const noSession = resetAction({ session: false });
  assert.match((await noSession.mod.resetPassword({ error: null }, noSession.form("correct horse battery"))).error, /expired/);
  assert.equal(noSession.calls.length, 0);

  const { mod, calls, form } = resetAction();
  assert.match((await mod.resetPassword({ error: null }, form("short"))).error, /at least 12/);
  assert.match((await mod.resetPassword({ error: null }, form("correct horse battery", "correct horse battery!"))).error, /do not match/);
  assert.match((await mod.resetPassword({ error: null }, form("é".repeat(40)))).error, /72 UTF-8 bytes/);
  assert.equal(calls.length, 0);
});

test("Auth rejections are shown safely and the user stays signed in to retry", async () => {
  const { mod, calls, form } = resetAction({ updateError: { code: "same_password" } });
  const state = await mod.resetPassword({ error: null }, form("correct horse battery"));
  assert.match(state.error, /different/);
  assert.deepEqual(calls.map((c) => c[0]), ["update"], "no sign-out after a failed update");
});

// ---------------------------------------------------------------------------
// /reset-password page
// ---------------------------------------------------------------------------
function renderPage(session) {
  const page = loadTsModule("src/app/reset-password/page.tsx", {
    "next/link": { __esModule: true, default: ({ href, children, ...props }) => React.createElement("a", { href, ...props }, children) },
    "@/features/auth/recovery.server": { getRecoverySession: async () => session },
    "@/features/auth/reset-password-form": { ResetPasswordForm: () => React.createElement("form", { "data-testid": "reset-form" }) },
  });
  return page.default().then((element) => renderToStaticMarkup(element));
}

test("reset page shows the form only for a fresh recovery session", async () => {
  const allowed = await renderPage({ client: {}, email: "admin@cyclo.test" });
  assert.match(allowed, /data-testid="reset-form"/);
  assert.match(allowed, /admin@cyclo\.test/);
  const denied = await renderPage(null);
  assert.doesNotMatch(denied, /reset-form/);
  assert.match(denied, /fresh password-reset link/);
  assert.match(denied, /href="\/login"/);
  assert.match(denied, /href="\/forgot-password"/, "offers a new link");
});

test("reset form has two password fields, a show/hide control and password-manager hints", () => {
  const { ResetPasswordForm } = loadTsModule("src/features/auth/reset-password-form.tsx", {
    "./recovery-actions": { resetPassword: async () => ({ error: null }) },
  });
  const html = renderToStaticMarkup(React.createElement(ResetPasswordForm));
  assert.equal((html.match(/autoComplete="new-password"|autocomplete="new-password"/g) ?? []).length, 2);
  assert.match(html, /name="password"/);
  assert.match(html, /name="confirmation"/);
  assert.match(html, /aria-label="Show passwords"/);
  assert.match(html, /minLength="12"|minlength="12"/);
  assert.match(html, /<button type="submit" disabled=""[^>]*>Update password<\/button>/, "submit stays disabled until both fields are valid");
});

test("password-recovery email template links to the recovery callback with a token hash", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../supabase/templates/password-recovery.html", import.meta.url), "utf8");
  assert.match(html, /href="\{\{ \.SiteURL \}\}\/auth\/recovery\?token_hash=\{\{ \.TokenHash \}\}&amp;type=recovery"/);
  assert.doesNotMatch(html, /ConfirmationURL|access_token/, "no implicit-flow link");
});

// ---------------------------------------------------------------------------
// Forgot password: request action
// ---------------------------------------------------------------------------
function requestAction({ authError = null, throws = false, redirect = "https://cyclo-alpha.vercel.app/auth/recovery" } = {}) {
  const calls = [];
  const logs = [];
  const mod = loadTsModule("src/features/auth/recovery-actions.ts", {
    "@/lib/supabase/server": {
      createClient: async () => ({
        auth: {
          resetPasswordForEmail: async (email, options) => {
            calls.push([email, options]);
            if (throws) throw new Error("network down: secret detail");
            return { data: {}, error: authError };
          },
        },
      }),
    },
    "./recovery.server": { getRecoverySession: async () => null, recoveryRedirectUrl: () => redirect },
    "next/navigation": { redirect() { throw new Error("unexpected redirect"); } },
  });
  const form = (email) => { const data = new FormData(); data.set("email", email); return data; };
  const originalError = console.error;
  const run = async (email) => {
    console.error = (...args) => logs.push(args.join(" "));
    try { return await mod.requestPasswordReset({ sent: false, error: null }, form(email)); } finally { console.error = originalError; }
  };
  return { run, calls, logs };
}

test("reset request sends the recovery email with the trusted redirect", async () => {
  const { run, calls } = requestAction();
  assert.deepEqual(plain(await run("  admin@cyclo.test ")), { sent: true, error: null });
  assert.deepEqual(plain(calls), [["admin@cyclo.test", { redirectTo: "https://cyclo-alpha.vercel.app/auth/recovery" }]]);
});

test("without a valid app origin the request still works and Auth uses the Site URL", async () => {
  const { run, calls } = requestAction({ redirect: null });
  assert.equal((await run("admin@cyclo.test")).sent, true);
  assert.equal(calls[0][1], undefined);
});

test("reset request never reveals whether the account exists or why sending failed", async () => {
  const outcomes = [];
  for (const options of [{}, { authError: { code: "user_not_found", status: 400 } }, { authError: { code: "over_email_send_rate_limit", status: 429 } }, { throws: true }]) {
    const { run, logs } = requestAction(options);
    outcomes.push(plain(await run("someone@cyclo.test")));
    assert.ok(logs.every((line) => !line.includes("someone@cyclo.test") && !line.includes("secret detail")), "logs carry codes only");
  }
  assert.ok(outcomes.every((o) => o.sent === true && o.error === null), JSON.stringify(outcomes));
});

test("invalid emails are rejected before Auth is called", async () => {
  const { run, calls } = requestAction();
  for (const email of ["", "not-an-email", "a@b", `${"x".repeat(250)}@cyclo.test`, "two words@cyclo.test"]) {
    const state = await run(email);
    assert.equal(state.sent, false, email);
    assert.match(state.error, /valid work email/);
  }
  assert.equal(calls.length, 0);
});

test("every accepted request takes a constant minimum time", async () => {
  const { run } = requestAction();
  const started = Date.now();
  await run("admin@cyclo.test");
  assert.ok(Date.now() - started >= 850, "padded response time");
});

// ---------------------------------------------------------------------------
// Trusted recovery redirect
// ---------------------------------------------------------------------------
function redirectFor(supabaseUrl, appUrl) {
  const mod = loadTsModule("src/features/auth/recovery.server.ts", {
    "server-only": {},
    "@/lib/supabase/env": { getSupabaseEnv: () => ({ url: supabaseUrl, publishableKey: "pk" }) },
    "@/lib/supabase/server": { createClient: async () => assert.fail("not used") },
  });
  const saved = process.env.CYCLO_APP_URL;
  if (appUrl === undefined) delete process.env.CYCLO_APP_URL; else process.env.CYCLO_APP_URL = appUrl;
  try { return mod.recoveryRedirectUrl(); } finally { if (saved === undefined) delete process.env.CYCLO_APP_URL; else process.env.CYCLO_APP_URL = saved; }
}

test("recovery redirect is built only from validated configuration", () => {
  const HOSTED = "https://jbcvznfxycngysxwtbsz.supabase.co";
  assert.equal(redirectFor(HOSTED, "https://cyclo-alpha.vercel.app"), "https://cyclo-alpha.vercel.app/auth/recovery");
  assert.equal(redirectFor("http://127.0.0.1:54321", "http://127.0.0.1:3105"), "http://127.0.0.1:3105/auth/recovery");
  assert.equal(redirectFor("http://127.0.0.1:54321", undefined), "http://127.0.0.1:3000/auth/recovery");
  assert.equal(redirectFor(HOSTED, "http://localhost:3000"), null, "hosted project never redirects to a local app");
  assert.equal(redirectFor(HOSTED, "https://evil.test/phish"), null);
  assert.equal(redirectFor(HOSTED, undefined), null);
});

// ---------------------------------------------------------------------------
// Forgot password UI and login link
// ---------------------------------------------------------------------------
const linkMock = { __esModule: true, default: ({ href, children, ...props }) => React.createElement("a", { href, ...props }, children) };

test("forgot-password page has an email field, a disabled send button and a way back", async () => {
  const { ForgotPasswordForm, NEUTRAL_RESET_MESSAGE } = loadTsModule("src/features/auth/forgot-password-form.tsx", {
    "next/link": linkMock,
    "./recovery-actions": { requestPasswordReset: async () => ({ sent: true, error: null }) },
  });
  const html = renderToStaticMarkup(React.createElement(ForgotPasswordForm));
  assert.match(html, /type="email"/);
  assert.match(html, /<button type="submit" disabled=""[^>]*>Send reset link<\/button>/);
  assert.match(html, /href="\/login"/);
  assert.equal(NEUTRAL_RESET_MESSAGE, "If an account exists for this email, you will receive a password reset link.");
  const page = loadTsModule("src/app/(auth)/forgot-password/page.tsx", { "@/features/auth/forgot-password-form": { ForgotPasswordForm: () => React.createElement("form") } });
  assert.match(renderToStaticMarkup(page.default()), /Forgot your password\?/);
});

test("login form links to Forgot password", () => {
  const { LoginForm } = loadTsModule("src/features/auth/login-form.tsx", {
    "next/link": linkMock,
    "@/features/auth/actions": { login: async () => ({ error: null }) },
  });
  assert.match(renderToStaticMarkup(React.createElement(LoginForm, { initialError: null })), /<a href="\/forgot-password"[^>]*>Forgot password\?<\/a>/);
});

test("password rules and strength feedback", () => {
  const form = loadTsModule("src/features/auth/reset-password-form.tsx", { "./recovery-actions": { resetPassword: async () => ({ error: null }) } });
  assert.deepEqual(plain(form.passwordChecks("short", "short")), { length: false, bytes: true, match: true });
  assert.deepEqual(plain(form.passwordChecks("correct horse battery", "correct horse batterx")), { length: true, bytes: true, match: false });
  assert.equal(form.passwordChecks("é".repeat(40), "é".repeat(40)).bytes, false, "72-byte limit");
  assert.equal(form.passwordStrength("short"), 0);
  assert.equal(form.passwordStrength("aaaaaaaaaaaaaaaa"), 1, "repetitive");
  assert.equal(form.passwordStrength("abcdefghijkl"), 1);
  assert.equal(form.passwordStrength("Abcdefgh1jkl"), 2);
  assert.equal(form.passwordStrength("Tr0ub4dor & horse staple"), 3);
});
