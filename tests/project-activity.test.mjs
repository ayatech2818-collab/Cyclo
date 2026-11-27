import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const activity = await import("../src/features/projects/activity.ts");
const { ProjectError } = await import("../src/features/projects/errors.ts");
const {
  ACTIVITY_ACTIONS, toActivityEntry, describeActivity, activityDetails, actorLabel, groupActivityByDay,
  relativeTime, isActivityCursor, fallbackActorAvatar, formatActivityTime,
} = activity;

const ACTOR = "00000000-0000-4000-a000-000000000001";
const row = (overrides = {}) => ({
  id: "00000000-0000-4000-a000-0000000000a1", action: "PROJECT_UPDATED", created_at: "2026-11-26T10:15:00.123456+00:00",
  actor_id: ACTOR, actor_name: "Adil", actor_avatar_kind: "default", actor_avatar_symbol: null,
  subject_name: null, previous_subject_name: null, changes: [], ...overrides,
});
const entry = (overrides) => toActivityEntry(row(overrides));

const migration = readFileSync(new URL("../supabase/migrations/20261127100000_project_activity_feed.sql", import.meta.url), "utf8");
const projectsMigration = readFileSync(new URL("../supabase/migrations/20261125100000_projects_foundation.sql", import.meta.url), "utf8");
const teamMigration = readFileSync(new URL("../supabase/migrations/20261126100000_project_team_members.sql", import.meta.url), "utf8");
// Latest definition of the audit action CHECK constraint (Phase 8G2 adds comment events).
const workMigration = readFileSync(new URL("../supabase/migrations/20261203100000_work_item_comments.sql", import.meta.url), "utf8");

test("the UI knows every audit event type the database records", () => {
  const check = workMigration.slice(workMigration.indexOf("add constraint project_audit_log_action_check"));
  const recorded = [...check.slice(0, check.indexOf(";")).matchAll(/'((?:PROJECT|WORK_ITEM|SPRINT)_[A-Z_]+)'/g)].map((match) => match[1]);
  assert.equal(recorded.length, 35);
  for (const action of new Set(recorded)) assert.ok(ACTIVITY_ACTIONS.includes(action), action);
  assert.equal(ACTIVITY_ACTIONS.length, 35);
  assert.ok(teamMigration.includes("PROJECT_MEMBER_REMOVED"));
});

test("execution events read as sentences and show their reason", () => {
  const item = { work_item_id: "00000000-0000-4000-a000-0000000000b1", work_item_key: "CYC-7", work_item_title: "Login" };
  const said = (action, changes = []) => describeActivity(entry({ action, changes, ...item }));
  assert.equal(said("WORK_ITEM_STARTED"), "started work on CYC-7");
  assert.equal(said("WORK_ITEM_SUBMITTED_FOR_REVIEW"), "submitted CYC-7 for review");
  assert.equal(said("WORK_ITEM_REVIEW_APPROVED"), "approved CYC-7");
  assert.equal(said("WORK_ITEM_REVIEW_REJECTED"), "requested changes on CYC-7");
  assert.equal(said("WORK_ITEM_BLOCKED"), "marked CYC-7 as blocked");
  assert.equal(said("WORK_ITEM_RESUMED"), "resumed work on CYC-7");
  const details = activityDetails(entry({ action: "WORK_ITEM_BLOCKED", ...item, changes: [{ field: "status", from: "IN_PROGRESS", to: "BLOCKED" }, { field: "reason", from: null, to: "Waiting on API keys" }] }));
  assert.deepEqual(details, [{ label: "Status", from: "In progress", to: "Blocked" }, { label: "Reason", from: null, to: "Waiting on API keys" }]);
});

test("every event type reads as a human sentence", () => {
  const sentence = (overrides) => `${actorLabel(entry(overrides))} ${describeActivity(entry(overrides))}`;
  assert.equal(sentence({ action: "PROJECT_CREATED" }), "Adil created the project");
  assert.equal(sentence({ changes: [{ field: "description" }] }), "Adil updated the project description");
  assert.equal(sentence({ changes: [{ field: "name", from: "A", to: "B" }] }), "Adil renamed the project");
  assert.equal(sentence({ changes: [{ field: "status", from: "planning", to: "active" }, { field: "priority", from: "low", to: "high" }] }), "Adil updated the project");
  assert.equal(sentence({ action: "PROJECT_MANAGER_CHANGED", subject_name: "Priya", previous_subject_name: "Sam" }), "Adil changed the Project Manager from Sam to Priya");
  assert.equal(sentence({ action: "PROJECT_MEMBER_ADDED", subject_name: "Dev Kumar" }), "Adil added Dev Kumar to the team");
  assert.equal(sentence({ action: "PROJECT_MEMBER_REMOVED", subject_name: "Dev Kumar" }), "Adil removed Dev Kumar from the team");
  assert.equal(sentence({ action: "PROJECT_ARCHIVED" }), "Adil archived the project");
  assert.equal(sentence({ action: "PROJECT_RESTORED" }), "Adil restored the project");
  assert.equal(sentence({ action: "PROJECT_RESTORED", actor_name: null }), "A former employee restored the project");
  assert.equal(describeActivity(entry({ action: "PROJECT_MEMBER_ADDED", subject_name: null })), "added a former employee to the team");
});

test("details use readable labels and never raw values or description text", () => {
  const updated = activityDetails(entry({ changes: [
    { field: "status", from: "planning", to: "on_hold" },
    { field: "priority", from: "high", to: "critical" },
    { field: "target_date", from: null, to: "2027-03-01" },
    { field: "description" },
  ] }));
  assert.deepEqual(updated, [
    { label: "Status", from: "Planning", to: "On hold" },
    { label: "Priority", from: "High", to: "Critical" },
    { label: "Target date", from: "Not set", to: "1 Mar 2027" },
    { label: "Description", from: null, to: "Updated" },
  ]);
  const created = activityDetails(entry({ action: "PROJECT_CREATED", changes: [
    { field: "name", to: "Web" }, { field: "project_key", to: "WEB" }, { field: "priority", to: "high" }, { field: "description" },
  ] }));
  assert.deepEqual(created, [
    { label: "Key", from: null, to: "WEB" },
    { label: "Priority", from: null, to: "High" },
    { label: "Description", from: null, to: "Added" },
  ]);
  assert.deepEqual(activityDetails(entry({ action: "PROJECT_ARCHIVED" })), []);
});

test("rows are parsed strictly; unknown fields and events are not displayed", () => {
  const parsed = entry({ changes: [{ field: "secret_internal", from: "x", to: "y" }, { field: "name", from: "A", to: "B", extra: 1 }], extra_column: "leak" });
  assert.deepEqual(parsed.changes, [{ field: "name", from: "A", to: "B" }]);
  assert.equal("extra_column" in parsed, false);
  assert.equal(toActivityEntry(row({ action: "SOMETHING_NEW" })), null);
  assert.throws(() => toActivityEntry(row({ actor_id: "not-a-uuid" })), ProjectError);
  assert.throws(() => toActivityEntry(row({ created_at: "yesterday" })), ProjectError);
  assert.throws(() => toActivityEntry(row({ changes: "[]" })), ProjectError);
  assert.equal(parsed.createdAt, "2026-11-26T10:15:00.123456+00:00", "microsecond timestamps are kept for the cursor");
});

test("actor avatars: server-resolved photo wins, then allow-listed emoji/icon, else initials", () => {
  const photo = { type: "image", src: "https://x.supabase.co/storage/v1/object/sign/avatars/a.png" };
  assert.deepEqual(toActivityEntry(row({ actor_avatar_kind: "emoji", actor_avatar_symbol: "rocket" }), new Map([[ACTOR, photo]])).actorAvatar, photo);
  assert.deepEqual(entry({ actor_avatar_kind: "emoji", actor_avatar_symbol: "rocket" }).actorAvatar, { type: "emoji", id: "rocket" });
  assert.deepEqual(fallbackActorAvatar("icon", "code"), { type: "icon", id: "code" });
  assert.deepEqual(fallbackActorAvatar("emoji", "<script>"), { type: "initials" });
  assert.deepEqual(fallbackActorAvatar("image", null), { type: "initials" });
});

test("entries are grouped by day with Today/Yesterday labels", () => {
  const now = new Date("2026-11-26T12:00:00Z");
  const items = [
    entry({ id: "00000000-0000-4000-a000-000000000011", created_at: "2026-11-26T09:00:00Z" }),
    entry({ id: "00000000-0000-4000-a000-000000000012", created_at: "2026-11-26T08:00:00Z" }),
    entry({ id: "00000000-0000-4000-a000-000000000013", created_at: "2026-11-25T23:00:00Z" }),
    entry({ id: "00000000-0000-4000-a000-000000000014", created_at: "2026-11-20T10:00:00Z" }),
  ];
  const groups = groupActivityByDay(items, now, "UTC");
  assert.deepEqual(groups.map((group) => [group.label, group.entries.length]), [["Today", 2], ["Yesterday", 1], ["Friday, 20 November 2026", 1]]);
  // The same instant falls on another day in another time zone.
  assert.equal(groupActivityByDay([items[2]], now, "Asia/Kolkata")[0].label, "Today");
  // Before hydration (epoch "now") only full dates are used.
  assert.equal(groupActivityByDay(items, new Date(0), "UTC")[0].label, "Thursday, 26 November 2026");
  assert.equal(formatActivityTime("2026-11-26T09:05:00Z", "UTC"), "09:05");
});

test("relative timestamps", () => {
  const now = new Date("2026-11-26T12:00:00Z");
  assert.equal(relativeTime("2026-11-26T11:59:30Z", now), "just now");
  assert.equal(relativeTime("2026-11-26T11:55:00Z", now), "5 minutes ago");
  assert.equal(relativeTime("2026-11-26T09:00:00Z", now), "3 hours ago");
  assert.equal(relativeTime("2026-11-25T11:00:00Z", now), "yesterday");
  assert.equal(relativeTime("2026-11-10T11:00:00Z", now), null, "older entries show the date only");
  assert.equal(relativeTime("2026-11-26T12:05:00Z", now), null, "future timestamps are not described");
});

test("load-more cursors are validated before reaching the database", () => {
  assert.equal(isActivityCursor({ createdAt: "2026-11-26T10:15:00.123456+00:00", id: ACTOR }), true);
  for (const bad of [null, "x", {}, { createdAt: "nope", id: ACTOR }, { createdAt: "2026-11-26T10:15:00Z", id: "1 or 1=1" }]) {
    assert.equal(isActivityCursor(bad), false, JSON.stringify(bad));
  }
});

test("activity RPC reuses the existing audit table and access helper", () => {
  assert.doesNotMatch(migration, /create table/i, "no new audit table");
  assert.match(migration, /perform private\.require_project_team_reader\(p_project_id\)/);
  assert.match(migration, /order by l\.created_at desc, l\.id desc/);
  assert.doesNotMatch(migration, /grant[^;]*on private\.project_audit_log to (authenticated|anon|service_role)/i);
  assert.doesNotMatch(migration, /grant select \([^)]*avatar_(url|path)/i, "no admin avatar URLs or storage paths");
  assert.match(projectsMigration, /create table private\.project_audit_log/);
});

test("the activity UI talks to the server only through server actions", () => {
  const source = readFileSync(new URL("../src/features/projects/components/project-activity.tsx", import.meta.url), "utf8");
  assert.match(source, /^"use client";/);
  assert.doesNotMatch(source, /@supabase|createClient|SECRET_KEY|service_role|project_audit_log/);
});
