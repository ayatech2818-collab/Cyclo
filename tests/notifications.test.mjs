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

const logic = await import("../src/features/notifications/logic.ts");
const { ProjectError } = await import("../src/features/projects/errors.ts");
const {
  NOTIFICATION_EVENTS, NOTIFICATION_CATEGORIES, toNotification, toNotificationPage, describeNotification, notificationDetail, notificationHref,
  commentExcerpt, mergeNotifications, markRead, matchesFilter, badgeLabel, parseNotificationQuery, notificationsHref, groupByDay, isNotificationCursor,
} = logic;

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../supabase/migrations/20261205100000_notifications.sql");
const provider = read("../src/features/notifications/components/notifications-provider.tsx");
const actions = read("../src/features/notifications/actions.ts");

const id = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
const row = (overrides = {}) => ({
  id: id(1), event_type: "MENTIONED", category: "mention", created_at: "2026-12-05T10:00:00Z", read_at: null,
  actor_id: id(2), actor_name: " Dev Kumar ", actor_avatar_kind: "emoji", actor_avatar_symbol: "rocket",
  accessible: true, project_id: id(3), project_name: "Checkout", project_key: "CPR",
  work_item_id: id(4), issue_key: "CPR-12", work_item_title: "Card form", comment_id: id(5),
  comment_body: `Please check <@${id(9)}>\nthanks`, comment_mentions: [{ id: id(9), name: "Priya" }], reason: null, ...overrides,
});

// ---------------------------------------------------------------------------
// Database contract
// ---------------------------------------------------------------------------

test("event types and categories match the database", () => {
  const events = [...migration.match(/event_type\s+text\s+not null check \(event_type in \(([^)]+)\)\)/s)[1].matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...NOTIFICATION_EVENTS].sort(), events.sort());
  const categories = [...migration.match(/category\s+text\s+not null check \(category in \(([^)]+)\)\)/)[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...NOTIFICATION_CATEGORIES], categories);
});

test("recipients come from trusted state; dedupe is enforced by the database", () => {
  assert.match(migration, /constraint notifications_recipient_dedupe_key unique \(recipient_id, dedupe_key\)/);
  assert.match(migration, /on conflict \(recipient_id, dedupe_key\) do nothing/);
  assert.match(migration, /constraint notifications_not_self check \(actor_id is null or actor_id <> recipient_id\)/);
  assert.match(migration, /create trigger project_audit_log_notify\s+after insert on private\.project_audit_log/, "transactional with the event");
  assert.match(migration, /if not private\.profile_can_access_project\(p_recipient, p_project\) then/, "only people who can access the project");
  assert.match(migration, /np\.category = p_category and not np\.in_app/, "preferences enforced at creation");
  assert.match(migration, /using \(recipient_id = \(select auth\.uid\(\)\)\)/, "RLS: own rows only");
  assert.doesNotMatch(migration, /grant (insert|update|delete)[^;]*on table public\.notifications to authenticated/i);
  assert.doesNotMatch(migration, /grant insert[^;]*on table public\.notifications to cyclo_project_api/i, "only the trigger inserts");
  assert.doesNotMatch(migration, /\b(title|message)\s+text/, "no stored text that could go stale or leak");
  for (const action of ["markNotificationsReadAction", "markAllNotificationsReadAction", "loadRecentNotificationsAction"]) {
    const body = actions.slice(actions.indexOf(`export async function ${action}`));
    assert.doesNotMatch(body.slice(0, body.indexOf("{")), /recipient|userId|profileId/, `${action} takes no identity`);
  }
});

test("one user-scoped subscription, signals only, cleaned up on unmount", () => {
  assert.match(provider, /filter: `recipient_id=eq\.\$\{userId\}`/);
  assert.match(provider, /\.channel\(`notifications:\$\{userId\}`\)/);
  assert.match(provider, /return \(\) => \{\s+active = false;[\s\S]*removeChannel\(channel\)/);
  assert.doesNotMatch(provider, /SECRET|SERVICE_ROLE/);
  assert.match(provider, /syncNotificationsAction/, "events are re-read through the server");
  const layout = read("../src/app/(dashboard)/layout.tsx");
  assert.match(layout, /<NotificationsProvider key=\{profile\.id\} userId=\{profile\.id\}/, "one provider per signed-in user");
});

// ---------------------------------------------------------------------------
// Rows and wording
// ---------------------------------------------------------------------------

test("rows parse fail-closed; inaccessible rows carry no names", () => {
  const notification = toNotification(row());
  assert.equal(notification.actorName, "Dev Kumar");
  assert.deepEqual(notification.workItem, { id: id(4), issueKey: "CPR-12", title: "Card form" });
  assert.equal(notification.comment.excerpt, "Please check @Priya thanks");
  const hidden = toNotification(row({ accessible: false }));
  assert.deepEqual([hidden.project, hidden.workItem, hidden.comment, hidden.reason], [null, null, null, null]);
  assert.equal(describeNotification(hidden), "sent you a notification about a project you no longer have access to");
  assert.equal(notificationHref(hidden), null);
  for (const bad of [row({ event_type: "PING" }), row({ category: "spam" }), row({ id: "1" }), row({ created_at: "soon" }), row({ accessible: "yes" }), null]) {
    assert.throws(() => toNotification(bad), ProjectError);
  }
});

test("every event has a sentence and a destination", () => {
  for (const event of NOTIFICATION_EVENTS) {
    const notification = toNotification(row({ event_type: event, comment_id: null }));
    assert.ok(describeNotification(notification).length > 5, event);
  }
  assert.equal(describeNotification(toNotification(row())), "mentioned you in CPR-12");
  assert.equal(describeNotification(toNotification(row({ event_type: "COMMENT_REPLY" }))), "replied to your comment on CPR-12");
  assert.equal(describeNotification(toNotification(row({ event_type: "PROJECT_MEMBER_ADDED", work_item_id: null }))), "added you to Checkout");
  assert.equal(notificationHref(toNotification(row())), `/projects/${id(3)}/work/${id(4)}#comment-${id(5)}`);
  assert.equal(notificationHref(toNotification(row({ comment_id: null }))), `/projects/${id(3)}/work/${id(4)}`);
  assert.equal(notificationHref(toNotification(row({ work_item_id: null, comment_id: null }))), `/projects/${id(3)}`);
  assert.equal(notificationDetail(toNotification(row({ comment_id: null, event_type: "REVIEW_CHANGES_REQUESTED", reason: "Add tests" }))), "“Add tests”");
  assert.equal(notificationDetail(toNotification(row({ comment_body: null }))), "This comment was deleted.");
  assert.equal(commentExcerpt("x".repeat(200), [], 20), `${"x".repeat(19)}…`);
});

// ---------------------------------------------------------------------------
// Lists, badge, filters
// ---------------------------------------------------------------------------

const n = (k, at, overrides = {}) => toNotification(row({ id: id(k), created_at: at, ...overrides }));

test("lists merge newest first without duplicates; read state applies in place", () => {
  const a = n(10, "2026-12-05T10:00:00Z");
  const b = n(11, "2026-12-05T11:00:00Z");
  const merged = mergeNotifications([a], [b, a, { ...b, readAt: "2026-12-05T12:00:00Z" }]);
  assert.deepEqual(merged.map((entry) => entry.id), [id(11), id(10)]);
  assert.equal(merged[0].readAt, "2026-12-05T12:00:00Z", "the latest version wins");
  const at = "2026-12-05T13:00:00Z";
  assert.deepEqual(markRead([a, b], new Set([id(10)]), at).map((entry) => entry.readAt), [at, null]);
  assert.deepEqual(markRead([a, b], "all", at).map((entry) => entry.readAt), [at, at]);
  assert.equal(markRead([{ ...a, readAt: "2026-12-01T00:00:00Z" }], "all", at)[0].readAt, "2026-12-01T00:00:00Z", "earlier read times are kept");
  const page = toNotificationPage([b, a], 1);
  assert.deepEqual([page.notifications.length, page.nextCursor], [1, { createdAt: b.createdAt, id: b.id }]);
  assert.equal(isNotificationCursor({ createdAt: b.createdAt, id: b.id }), true);
  assert.equal(isNotificationCursor({ createdAt: "x", id: b.id }), false);
});

test("badge, filters and URLs", () => {
  assert.deepEqual([0, 1, 99, 100, 5000].map(badgeLabel), [null, "1", "99", "99+", "99+"]);
  const unread = n(20, "2026-12-05T10:00:00Z");
  const readOne = n(21, "2026-12-05T10:00:00Z", { read_at: "2026-12-05T11:00:00Z", category: "comment", event_type: "COMMENT_ADDED" });
  assert.equal(matchesFilter(unread, "unread", null), true);
  assert.equal(matchesFilter(readOne, "unread", null), false);
  assert.equal(matchesFilter(readOne, "read", "comment"), true);
  assert.equal(matchesFilter(unread, "all", "comment"), false);
  assert.deepEqual(parseNotificationQuery({}), { status: "all", category: null });
  assert.deepEqual(parseNotificationQuery({ status: "unread", type: "mention" }), { status: "unread", category: "mention" });
  assert.deepEqual(parseNotificationQuery({ status: "deleted", type: "spam" }), { status: "all", category: null });
  assert.equal(notificationsHref({ status: "all", category: null }), "/notifications");
  assert.equal(notificationsHref({ status: "all", category: null }, { status: "unread", category: "review_decision" }), "/notifications?status=unread&type=review_decision");
});

test("history groups by day", () => {
  const now = new Date("2026-12-05T15:00:00Z");
  const groups = groupByDay([n(30, "2026-12-05T09:00:00Z"), n(31, "2026-12-05T08:00:00Z"), n(32, "2026-12-04T20:00:00Z"), n(33, "2026-11-30T10:00:00Z")], now, "UTC");
  assert.deepEqual(groups.map((group) => [group.label, group.notifications.length]), [["Today", 2], ["Yesterday", 1], ["Monday, 30 November 2026", 1]]);
});
