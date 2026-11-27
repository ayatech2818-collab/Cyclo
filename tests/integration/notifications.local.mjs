// Integration check of notifications (Phase 8G3) through the REAL local
// Supabase HTTP + Realtime stack: generation per event, deduplication,
// concurrency, offline persistence, read state and recipient-scoped
// Realtime delivery. LOCAL ONLY.
//
//   node --env-file=.env.supabase-local --test tests/integration/notifications.local.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createFixtures, runId } from "../helpers/project-fixtures.mjs";

const run = runId();
const { users, makeUser, cleanup } = createFixtures(`notify-${run}`);
const ids = {};
const channels = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tok = (name) => `<@${users[name].id}>`;

const comment = (user, item, body, parent) =>
  users[user].client.rpc("create_work_item_comment", { p_work_item_id: ids[item], p_body: body, p_parent_comment_id: parent });
const execute = (user, item, action, expected, reason) =>
  users[user].client.rpc("execute_work_item", { p_work_item_id: ids[item], p_action: action, p_expected_status: expected, p_reason: reason });
async function inbox(user, args = {}) {
  const { data, error } = await users[user].client.rpc("list_notifications", { p_limit: 51, ...args });
  if (error) throw error;
  return data;
}
const about = async (user, predicate) => (await inbox(user)).filter(predicate);
const unreadCount = async (user) => (await users[user].client.rpc("notification_unread_count")).data;

async function listen(client, recipientId) {
  const events = [];
  const system = [];
  const channel = client.channel(`notify-test:${recipientId}:${Math.random()}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `recipient_id=eq.${recipientId}` }, (payload) => events.push(payload))
    .on("system", {}, (payload) => system.push(payload));
  channels.push({ client, channel });
  channel.subscribe();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !system.some((entry) => entry.extension === "postgres_changes")) await wait(25);
  const ack = system.find((entry) => entry.extension === "postgres_changes");
  return { events, ready: ack?.status === "ok" };
}
async function until(predicate, ms = 8_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(50);
  }
  return false;
}

before(async () => {
  await makeUser("sa", "SUPER_ADMIN");
  await makeUser("pm", "PROJECT_MANAGER");
  await makeUser("dev1", "DEVELOPER");
  await makeUser("dev2", "DEVELOPER");
  await makeUser("other", "DEVELOPER");
  const project = await users.pm.client.rpc("create_project", { p_name: `Notify ${run}`, p_project_key: `N${run}`, p_priority: "medium" });
  if (project.error) throw project.error;
  ids.project = project.data;
  for (const dev of ["dev1", "dev2"]) await users.pm.client.rpc("add_project_member", { p_project_id: ids.project, p_profile_id: users[dev].id });
  for (const [key, assignee] of [["a", "dev1"], ["b", "dev1"], ["c", null]]) {
    const item = await users.pm.client.rpc("create_work_item", {
      p_project_id: ids.project, p_type: key === "c" ? "STORY" : "TASK", p_title: `${key} ${run}`, p_status: "TODO", p_assignee_id: assignee ? users[assignee].id : undefined,
    });
    if (item.error) throw item.error;
    ids[key] = item.data;
  }
  for (const { client } of Object.values(users)) await client.realtime.setAuth();
});

after(async () => {
  for (const { client, channel } of channels) await client.removeChannel(channel);
  await cleanup();
});

test("membership and assignment at creation are notified; nobody hears about their own actions", async () => {
  assert.equal((await about("dev1", (row) => row.event_type === "PROJECT_MEMBER_ADDED")).length, 1);
  assert.equal((await about("dev1", (row) => row.event_type === "WORK_ITEM_ASSIGNED")).length, 2, "items a and b");
  assert.equal((await inbox("pm")).length, 0, "the PM did everything themself");
});

test("comments, replies and mentions reach the right people once", async () => {
  const top = await comment("dev2", "a", "Looks close");
  assert.equal(top.error, null);
  const topId = top.data[0].id;
  assert.equal((await about("dev1", (row) => row.comment_id === topId)).map((row) => row.event_type).join(), "COMMENT_ADDED", "assignee");
  assert.equal((await about("pm", (row) => row.comment_id === topId)).map((row) => row.event_type).join(), "COMMENT_ADDED", "PM");
  assert.equal((await about("dev2", (row) => row.comment_id === topId)).length, 0, "not the author");

  const reply = await comment("pm", "a", "Agreed", topId);
  const replyId = reply.data[0].id;
  assert.equal((await about("dev2", (row) => row.comment_id === replyId)).map((row) => row.event_type).join(), "COMMENT_REPLY", "the parent author");
  assert.equal((await about("dev1", (row) => row.comment_id === replyId)).map((row) => row.event_type).join(), "REPLY_ADDED");
  assert.equal((await about("pm", (row) => row.comment_id === replyId)).length, 0, "not the replier");

  const mention = await comment("dev2", "a", `${tok("sa")} ${tok("dev1")} ${tok("pm")} please look`);
  const mentionId = mention.data[0].id;
  for (const name of ["sa", "dev1", "pm"]) {
    const rows = await about(name, (row) => row.comment_id === mentionId);
    assert.deepEqual(rows.map((row) => row.event_type), ["MENTIONED"], `${name}: one notification, as a mention`);
  }
  const [row] = await about("sa", (entry) => entry.comment_id === mentionId);
  assert.equal(row.issue_key.startsWith(`N${run}-`), true);
  assert.match(row.comment_body, /please look/);
  assert.equal(row.actor_name, `IT dev2 notify-${run}`);
});

test("an outsider mention is refused and creates nothing", async () => {
  const before = (await inbox("other")).length;
  assert.equal((await comment("dev2", "a", `hi ${tok("other")}`)).error?.message, "invalid_mention");
  assert.equal((await inbox("other")).length, before);
});

test("assignment, review and blocked work notify the right side", async () => {
  assert.equal((await users.pm.client.rpc("assign_work_item", { p_work_item_id: ids.b, p_assignee_id: users.dev2.id })).error, null);
  assert.equal((await about("dev2", (row) => row.work_item_id === ids.b && row.event_type === "WORK_ITEM_ASSIGNED")).length, 1, "new assignee");
  assert.equal((await about("dev1", (row) => row.work_item_id === ids.b && row.event_type === "WORK_ITEM_ASSIGNED")).length, 1, "the previous assignee only has the original");

  assert.equal((await execute("dev2", "b", "start", "TODO")).error, null);
  assert.equal((await execute("dev2", "b", "block", "IN_PROGRESS", "Waiting for design")).error, null);
  const blocked = await about("pm", (row) => row.work_item_id === ids.b && row.event_type === "WORK_ITEM_BLOCKED");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].reason, "Waiting for design");
  assert.equal((await execute("dev2", "b", "resume", "BLOCKED")).error, null);
  assert.equal((await about("pm", (row) => row.work_item_id === ids.b && row.event_type === "WORK_ITEM_RESUMED")).length, 1);

  assert.equal((await execute("dev2", "b", "submit_review", "IN_PROGRESS")).error, null);
  assert.equal((await about("pm", (row) => row.work_item_id === ids.b && row.event_type === "REVIEW_REQUESTED")).length, 1);
  assert.equal((await execute("pm", "b", "reject", "IN_REVIEW", "Needs tests")).error, null);
  const rejected = await about("dev2", (row) => row.work_item_id === ids.b && row.event_type === "REVIEW_CHANGES_REQUESTED");
  assert.deepEqual([rejected.length, rejected[0].reason], [1, "Needs tests"]);
  assert.equal((await execute("dev2", "b", "submit_review", "IN_PROGRESS")).error, null);
  assert.equal((await execute("pm", "b", "approve", "IN_REVIEW")).error, null);
  assert.equal((await about("dev2", (row) => row.work_item_id === ids.b && row.event_type === "REVIEW_APPROVED")).length, 1);
});

test("concurrent events never duplicate notifications", async () => {
  // Same approval twice in parallel: one change, one no-op, one notification.
  assert.equal((await execute("dev1", "a", "start", "TODO")).error, null);
  assert.equal((await execute("dev1", "a", "submit_review", "IN_PROGRESS")).error, null);
  const approvals = await Promise.all([execute("pm", "a", "approve", "IN_REVIEW"), users.sa.client.rpc("execute_work_item", { p_work_item_id: ids.a, p_action: "approve", p_expected_status: "IN_REVIEW" })]);
  assert.ok(approvals.every((result) => !result.error), JSON.stringify(approvals.map((result) => result.error)));
  assert.equal((await about("dev1", (row) => row.work_item_id === ids.a && row.event_type === "REVIEW_APPROVED")).length, 1);

  // Many comments at once: exactly one notification per comment per recipient.
  const results = await Promise.all(Array.from({ length: 8 }, (_, n) => comment(n % 2 ? "dev2" : "sa", "c", `Parallel ${n} ${tok("dev1")}`)));
  assert.ok(results.every((result) => !result.error));
  const created = new Set(results.map((result) => result.data[0].id));
  const forDev1 = await about("dev1", (row) => created.has(row.comment_id));
  assert.equal(forDev1.length, 8, "one per comment");
  assert.equal(new Set(forDev1.map((row) => row.comment_id)).size, 8, "no duplicates");
});

test("notifications wait for people who are offline, and read state is theirs alone", async () => {
  // dev2 has no subscription at all here; everything above is waiting.
  const unread = await unreadCount("dev2");
  assert.ok(unread >= 5, `dev2 has ${unread} unread`);
  assert.equal(unread, (await inbox("dev2", { p_status: "unread" })).length);
  const someoneElses = (await inbox("pm", { p_status: "unread" })).map((row) => row.id);
  assert.ok(someoneElses.length > 0);
  await users.dev2.client.rpc("mark_notifications_read", { p_ids: someoneElses });
  assert.equal((await inbox("pm", { p_status: "unread" })).length, someoneElses.length, "dev2 cannot mark the PM's notifications");
  const direct = await users.dev2.client.from("notifications").update({ read_at: new Date().toISOString() }).eq("recipient_id", users.pm.id).select();
  assert.ok(direct.error || direct.data.length === 0, "no direct updates");
  const [first] = await inbox("dev2", { p_status: "unread" });
  const remaining = (await users.dev2.client.rpc("mark_notifications_read", { p_ids: [first.id] })).data;
  assert.equal(remaining, unread - 1);
  assert.equal((await users.dev2.client.rpc("mark_all_notifications_read")).error, null);
  assert.equal(await unreadCount("dev2"), 0);
  assert.ok((await unreadCount("pm")) > 0, "other people's unread stay unread");
});

test("Realtime delivers each person's notifications to them only", async () => {
  const own = await listen(users.dev1.client, users.dev1.id);
  const spy = await listen(users.other.client, users.dev1.id); // someone else asking for dev1's stream
  const spyPm = await listen(users.dev2.client, users.pm.id);
  assert.ok(own.ready && spy.ready && spyPm.ready, "subscriptions acknowledged");

  const created = await comment("dev2", "a", `Live ping ${tok("dev1")}`);
  assert.equal(created.error, null);
  assert.ok(await until(() => own.events.some((event) => event.eventType === "INSERT" && event.new.comment_id === created.data[0].id)), "the recipient gets it instantly");
  const [event] = own.events.filter((entry) => entry.new?.comment_id === created.data[0].id);
  assert.equal(event.new.recipient_id, users.dev1.id);
  assert.equal(event.new.body, undefined, "no comment text in the stream");

  const mark = await users.dev1.client.rpc("mark_notifications_read", { p_ids: [event.new.id] });
  assert.equal(mark.error, null);
  assert.ok(await until(() => own.events.some((entry) => entry.eventType === "UPDATE" && entry.new.id === event.new.id && entry.new.read_at)), "read state streams to the recipient's other tabs");

  await wait(1_000);
  assert.equal(spy.events.length, 0, "another user filtering on dev1's id receives nothing");
  assert.equal(spyPm.events.length, 0, "a developer filtering on the PM's id receives nothing");
});
