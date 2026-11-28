import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import { loadTsModule } from "./helpers/load-ts-module.mjs";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const ID = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000002";
const OBJ = "11111111-2222-4333-8444-555555555555";
const SUPABASE = "http://127.0.0.1:54321";

const catalog = loadTsModule("src/features/profile/avatar-catalog.ts");
const avatar = loadTsModule("src/features/profile/avatar.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Catalog parity with the database CHECK constraint
// ---------------------------------------------------------------------------
test("emoji and icon allowlists match the migration CHECK constraint exactly", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261124100000_own_profile_avatars.sql", import.meta.url), "utf8");
  const list = (kind) => {
    const match = new RegExp(`avatar_kind = '${kind}' and avatar_symbol is not null and avatar_symbol = any \\(array\\[([^\\]]+)\\]`).exec(sql);
    assert.ok(match, `${kind} list present`);
    return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  };
  assert.deepEqual(list("emoji"), [...catalog.EMOJI_AVATAR_IDS].sort());
  assert.deepEqual(list("icon"), [...catalog.ICON_AVATAR_IDS].sort());
  for (const id of [...catalog.EMOJI_AVATAR_IDS, ...catalog.ICON_AVATAR_IDS]) assert.match(id, /^[a-z][a-z0-9-]{0,31}$/);
});

test("every icon identifier maps to a component and every emoji to one character sequence", () => {
  const icons = loadTsModule("src/features/profile/avatar-icons.tsx");
  for (const id of catalog.ICON_AVATAR_IDS) assert.ok(icons.AVATAR_ICON_COMPONENTS[id], id);
  assert.equal(Object.keys(icons.AVATAR_ICON_COMPONENTS).length, catalog.ICON_AVATAR_IDS.length);
  for (const id of catalog.EMOJI_AVATAR_IDS) assert.doesNotMatch(catalog.EMOJI_AVATARS[id].char, /[<>&"'a-z]/i);
  assert.equal(catalog.isEmojiAvatarId("toString"), false, "prototype keys are not identifiers");
  assert.equal(catalog.isIconAvatarId("__proto__"), false);
});

// ---------------------------------------------------------------------------
// State parsing and display priority
// ---------------------------------------------------------------------------
const row = (overrides = {}) => ({ id: ID, avatar_kind: "default", avatar_symbol: null, avatar_path: null, avatar_url: null, ...overrides });

test("avatar state parser accepts valid rows and fails closed on anything else", () => {
  assert.deepEqual(plain(avatar.toAvatarState(ID, row({ avatar_kind: "emoji", avatar_symbol: "rocket" }))), { kind: "emoji", symbol: "rocket", path: null, url: null });
  assert.deepEqual(plain(avatar.toAvatarState(ID, row({ avatar_kind: "image", avatar_path: `${ID}/${OBJ}.png` }))).path, `${ID}/${OBJ}.png`);
  const bad = [
    row({ avatar_kind: "svg" }),
    row({ avatar_kind: "emoji", avatar_symbol: "<script>" }),
    row({ avatar_kind: "icon", avatar_symbol: "rocket-launcher" }),
    row({ avatar_kind: "emoji", avatar_symbol: null }),
    row({ avatar_kind: "image", avatar_path: null }),
    row({ avatar_path: `${OTHER}/${OBJ}.png` }),
    row({ avatar_path: `${ID}/${OBJ}.gif` }),
    row({ avatar_path: `${ID}/../${OBJ}.png` }),
    row({ avatar_url: 42 }),
    null,
    [],
  ];
  for (const value of bad) assert.throws(() => avatar.toAvatarState(ID, value), avatar.AvatarStateError, JSON.stringify(value));
});

test("display priority: image > emoji/icon > admin avatar_url (default only) > initials", () => {
  const url = "https://cdn.test/a.png";
  const signed = `${SUPABASE}/storage/v1/object/sign/avatars/${ID}/${OBJ}.png?token=t`;
  const resolve = (state, src = null) => plain(avatar.resolveAvatar(state, src));
  assert.deepEqual(resolve({ kind: "image", symbol: null, path: "p", url }, signed), { type: "image", src: signed });
  assert.deepEqual(resolve({ kind: "image", symbol: null, path: "p", url }, null), { type: "url", src: url }, "unreadable image falls back");
  assert.deepEqual(resolve({ kind: "emoji", symbol: "fox", path: "p", url }), { type: "emoji", id: "fox" }, "emoji overrides admin URL and kept photo");
  assert.deepEqual(resolve({ kind: "icon", symbol: "code", path: null, url }), { type: "icon", id: "code" });
  assert.deepEqual(resolve({ kind: "default", symbol: null, path: null, url }), { type: "url", src: url });
  assert.deepEqual(resolve({ kind: "initials", symbol: null, path: null, url }), { type: "initials" }, "explicit initials hide admin URL");
  assert.deepEqual(resolve({ kind: "default", symbol: null, path: null, url: "http://insecure.test/a.png" }), { type: "initials" });
  assert.deepEqual(resolve(null), { type: "initials" });
});

test("only signed URLs for this project's avatars bucket are trusted", () => {
  const ok = `${SUPABASE}/storage/v1/object/sign/avatars/${ID}/${OBJ}.png?token=abc`;
  assert.equal(avatar.trustedSignedUrl(SUPABASE, ok), ok);
  for (const value of [
    `https://evil.test/storage/v1/object/sign/avatars/${ID}/${OBJ}.png`,
    `${SUPABASE}/storage/v1/object/public/avatars/${ID}/${OBJ}.png`,
    `${SUPABASE}/storage/v1/object/sign/other/${ID}/${OBJ}.png`,
    `http://user:pw@127.0.0.1:54321/storage/v1/object/sign/avatars/x.png`,
    "javascript:alert(1)",
    "not a url",
    null,
  ]) assert.equal(avatar.trustedSignedUrl(SUPABASE, value), null, String(value));
});

// ---------------------------------------------------------------------------
// Upload validation
// ---------------------------------------------------------------------------
const bytes = (...values) => new Uint8Array([...values, ...new Array(16).fill(0)]);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50);

test("uploads are identified by file signature; SVG, GIF, HTML and empty files are rejected", () => {
  assert.equal(avatar.detectAvatarImage(JPEG).ext, "jpg");
  assert.equal(avatar.detectAvatarImage(PNG).ext, "png");
  assert.equal(avatar.detectAvatarImage(WEBP).ext, "webp");
  const text = (s) => new TextEncoder().encode(s);
  for (const value of [text("<svg xmlns='http://www.w3.org/2000/svg'/>"), text("GIF89a......"), text("<!doctype html><script>"), new Uint8Array()]) {
    assert.equal(avatar.detectAvatarImage(value), null);
  }
  assert.deepEqual(plain(avatar.checkAvatarUpload(0, new Uint8Array())), { ok: false, reason: "missing" });
  assert.deepEqual(plain(avatar.checkAvatarUpload(avatar.AVATAR_MAX_BYTES + 1, PNG)), { ok: false, reason: "too_large" });
  assert.deepEqual(plain(avatar.checkAvatarUpload(10, text("GIF89a"))), { ok: false, reason: "unsupported" });
  assert.equal(avatar.checkAvatarUpload(avatar.AVATAR_MAX_BYTES, PNG).ok, true);
});

// ---------------------------------------------------------------------------
// Server mutations
// ---------------------------------------------------------------------------
function mutations({ rpcResult = { data: [{ previous_path: null }], error: null }, uploadError = null } = {}) {
  const calls = [];
  const storage = {
    upload: async (path, body, options) => { calls.push(["upload", path, options.contentType, options.upsert]); return { error: uploadError }; },
    remove: async (paths) => { calls.push(["remove", ...paths]); return { error: null }; },
  };
  const client = {
    rpc: async (name, args) => { calls.push(["rpc", name, args]); return typeof rpcResult === "function" ? rpcResult(name) : rpcResult; },
    storage: { from: (bucket) => { assert.equal(bucket, "avatars"); return storage; } },
  };
  const mod = loadTsModule("src/features/profile/mutations.server.ts", {
    "server-only": {},
    "@/features/auth/server": { requireActiveProfile: async () => ({ profile: { id: ID, role: "DEVELOPER" } }) },
    "@/lib/supabase/server": { createClient: async () => client },
  });
  return { mod, calls };
}

test("avatar selection sends only allowlisted identifiers and never an employee id", async () => {
  const { mod, calls } = mutations();
  await mod.selectAvatar("emoji", "rocket");
  await mod.selectAvatar("icon", "git-branch");
  await mod.selectAvatar("initials", "");
  await mod.selectAvatar("default", null);
  assert.deepEqual(calls.map((c) => plain(c[2])), [
    { p_kind: "emoji", p_symbol: "rocket" },
    { p_kind: "icon", p_symbol: "git-branch" },
    { p_kind: "initials" },
    { p_kind: "default" },
  ]);
  for (const [kind, symbol] of [["emoji", "<img src=x onerror=alert(1)>"], ["icon", "rocket-launcher"], ["emoji", "code"], ["svg", null], ["initials", "fox"], [null, null], ["image", "x"]]) {
    await assert.rejects(mod.selectAvatar(kind, symbol), { name: "ProfileError", code: "invalid_avatar" });
  }
  assert.equal(calls.length, 4, "invalid choices never reach the database");
});

test("upload generates its own path, ignores the client file name and type, and replaces the old object", async () => {
  const previous = `${ID}/${OBJ}.jpg`;
  const { mod, calls } = mutations({ rpcResult: { data: [{ previous_path: previous }], error: null } });
  const file = new File([PNG], "../../evil.svg", { type: "image/svg+xml" });
  await mod.uploadAvatar(file);
  const [upload, rpc, remove] = calls;
  assert.equal(upload[0], "upload");
  assert.match(upload[1], new RegExp(`^${ID}/[0-9a-f-]{36}\\.png$`));
  assert.equal(upload[2], "image/png");
  assert.equal(upload[3], false, "never overwrites");
  assert.deepEqual(plain(rpc), ["rpc", "set_my_avatar_image", { p_path: upload[1] }]);
  assert.deepEqual(remove, ["remove", previous]);
});

test("a failed attach removes the just-uploaded object; foreign previous paths are never deleted", async () => {
  const failed = mutations({ rpcResult: { data: null, error: { code: "22023", message: "avatar_object_missing" } } });
  await assert.rejects(failed.mod.uploadAvatar(new File([JPEG], "a.jpg")), { code: "invalid_avatar" });
  assert.equal(failed.calls.at(-1)[0], "remove");
  assert.equal(failed.calls.at(-1)[1], failed.calls[0][1]);

  const foreign = mutations({ rpcResult: { data: [{ previous_path: `${OTHER}/${OBJ}.png` }], error: null } });
  await foreign.mod.removeAvatarImage();
  assert.deepEqual(foreign.calls.map((c) => c[0]), ["rpc"], "a path outside the caller's folder is ignored");
});

test("invalid uploads are rejected before Storage is called", async () => {
  const { mod, calls } = mutations();
  await assert.rejects(mod.uploadAvatar("not a file"), { code: "file_missing" });
  await assert.rejects(mod.uploadAvatar(new File([new TextEncoder().encode("<svg/>")], "a.png", { type: "image/png" })), { code: "file_unsupported" });
  await assert.rejects(mod.uploadAvatar(new File([new Uint8Array(avatar.AVATAR_MAX_BYTES + 1)], "big.png")), { code: "file_too_large" });
  const storageFailure = mutations({ uploadError: { message: "mime type not allowed" } });
  await assert.rejects(storageFailure.mod.uploadAvatar(new File([PNG], "a.png")), { code: "upload_failed" });
  assert.equal(calls.length, 0);
});

test("name updates are trimmed, bounded and mapped to safe errors", async () => {
  const { mod, calls } = mutations({ rpcResult: { data: [{ full_name: "Ada" }], error: null } });
  await mod.updateMyName("  Ada  ");
  assert.deepEqual(plain(calls[0]), ["rpc", "update_my_profile", { p_full_name: "Ada" }]);
  await assert.rejects(mod.updateMyName("   "), { code: "invalid_full_name" });
  await assert.rejects(mod.updateMyName("x".repeat(201)), { code: "invalid_full_name" });
  await assert.rejects(mod.updateMyName(null), { code: "invalid_full_name" });
  const denied = mutations({ rpcResult: { data: null, error: { code: "42501", message: "forbidden" } } });
  await assert.rejects(denied.mod.updateMyName("Ada"), { code: "forbidden" });
  const raw = mutations({ rpcResult: { data: null, error: { code: "XX000", message: "relation secret_table does not exist" } } });
  await assert.rejects(raw.mod.updateMyName("Ada"), (error) => error.code === "unavailable" && !error.message.includes("secret_table"));
});

test("profile actions return safe feedback and revalidate the whole layout", async () => {
  const revalidated = [];
  const errors = loadTsModule("src/features/profile/errors.ts");
  const actions = loadTsModule("src/features/profile/actions.ts", {
    "next/cache": { revalidatePath: (...args) => revalidated.push(args) },
    "./errors": errors,
    "./mutations.server": {
      updateMyName: async (name) => { if (name === "bad") throw new errors.ProfileError("invalid_full_name"); },
      selectAvatar: async () => {}, uploadAvatar: async () => {}, removeAvatarImage: async () => {},
    },
  });
  const data = (entries) => { const form = new FormData(); for (const [k, v] of Object.entries(entries)) form.set(k, v); return form; };
  assert.deepEqual(plain(await actions.updateNameAction({ error: null, success: null }, data({ fullName: "Ada" }))), { error: null, success: "Name updated." });
  assert.deepEqual(plain(revalidated), [["/", "layout"]]);
  assert.deepEqual(plain(await actions.updateNameAction({ error: null, success: null }, data({ fullName: "bad" }))), { error: errors.PROFILE_ERROR_MESSAGES.invalid_full_name, success: null });
  assert.equal(revalidated.length, 1, "failures do not revalidate");
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
test("avatar rendering uses only catalog content and safe image sources", () => {
  const { EmployeeAvatar } = loadTsModule("src/features/employees/components/employee-avatar.tsx");
  const render = (props) => renderToStaticMarkup(React.createElement(EmployeeAvatar, { fullName: "Ada Lovelace", email: null, avatarUrl: null, ...props }));
  assert.match(render({ avatar: { type: "emoji", id: "fox" } }), /🦊/);
  assert.match(render({ avatar: { type: "icon", id: "code" } }), /<svg[^>]*lucide/);
  assert.match(render({ avatar: { type: "initials" } }), />AL</);
  const signed = `${SUPABASE}/storage/v1/object/sign/avatars/${ID}/${OBJ}.png?token=t`;
  const img = render({ avatar: { type: "image", src: signed } });
  assert.match(img, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
  assert.match(img, /alt=""/);
  // Without a resolved avatar the Phase 4 behaviour is unchanged.
  assert.match(render({ avatarUrl: "https://cdn.test/a.png" }), /src="https:\/\/cdn.test\/a.png"/);
  assert.match(render({ avatarUrl: "http://cdn.test/a.png" }), />AL</);
});

test("header shows the account menu with the resolved avatar, the bell and the theme toggle", () => {
  const { AppHeader } = loadTsModule("src/components/layout/app-header.tsx", {
    "next/link": { __esModule: true, default: ({ href, children, ...props }) => React.createElement("a", { href, ...props }, children) },
    "next/navigation": { usePathname: () => "/dashboard" },
    "@/features/auth/actions": { logout: async () => {} },
    "@/components/theme/theme-toggle": { ThemeToggle: () => React.createElement("button", { "aria-label": "Theme" }) },
    "@/features/notifications/components/notification-bell": { NotificationBell: () => React.createElement("button", { "aria-label": "Notifications" }) },
    "./mobile-nav": { MobileNav: () => React.createElement("button", { "aria-label": "Open navigation" }) },
    "./page-title": { PageTitle: () => React.createElement("span", null, "Dashboard") },
  });
  const html = renderToStaticMarkup(React.createElement(AppHeader, {
    profile: { id: ID, full_name: "Ada", email: "ada@cyclo.test", role: "DEVELOPER", is_active: true },
    theme: "system",
    avatar: { type: "emoji", id: "rocket" },
  }));
  assert.match(html, /aria-label="Account: Ada"/);
  assert.match(html, /🚀/);
  assert.match(html, /aria-label="Notifications"/, "every employee gets the notification bell");
  assert.match(html, /aria-label="Theme"/);
  assert.match(html, /aria-label="Open navigation"/, "phone menu trigger");
  assert.doesNotMatch(html, /href="\/employees"/, "navigation lives in the sidebar, not the header");
});
