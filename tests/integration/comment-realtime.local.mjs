// Realtime authorization for work item comments (Phase 8G2) against the REAL
// local Supabase stack: changes reach project members only, per work item,
// for INSERT and UPDATE (edit / soft delete); outsiders and anonymous clients
// receive nothing. LOCAL ONLY.
//
//   node --env-file=.env.supabase-local --test tests/integration/comment-realtime.local.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createClient } from "@supabase/supabase-js";

import { createFixtures, runId } from "../helpers/project-fixtures.mjs";

const run = runId();
const { users, makeUser, cleanup } = createFixtures(`rt-${run}`);
const ids = {};
const channels = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Subscribes `client` to one work item's comments; resolves once SUBSCRIBED (or with the failure status). */
async function listen(client, workItemId, label) {
  const events = [];
  const system = [];
  const channel = client
    .channel(`test:${label}:${workItemId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "work_item_comments", filter: `work_item_id=eq.${workItemId}` },
      (payload) => events.push(payload))
    .on("system", {}, (payload) => system.push(payload));
  channels.push({ client, channel });
  // Ready only when the server confirms the Postgres Changes subscription (it can follow SUBSCRIBED).
  const status = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("TIMEOUT"), 15_000);
    const poll = setInterval(() => {
      const ack = system.find((entry) => entry.extension === "postgres_changes");
      if (ack) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(ack.status === "ok" ? "SUBSCRIBED" : `ERROR: ${ack.message}`);
      }
    }, 25);
    channel.subscribe((value) => {
      if (value === "CHANNEL_ERROR" || value === "TIMED_OUT") {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(value);
      }
    });
  });
  return { events, status };
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
  await makeUser("dev", "DEVELOPER");
  await makeUser("member2", "DEVELOPER");
  await makeUser("otherdev", "DEVELOPER");
  await makeUser("outsider", "DEVELOPER");
  for (const [key, members] of [["p1", ["dev", "member2"]], ["p2", ["otherdev"]]]) {
    const project = await users.pm.client.rpc("create_project", { p_name: `Realtime ${key} ${run}`, p_project_key: `T${key.toUpperCase()}${run}`.slice(0, 10), p_priority: "medium" });
    if (project.error) throw project.error;
    ids[key] = project.data;
    for (const member of members) await users.pm.client.rpc("add_project_member", { p_project_id: ids[key], p_profile_id: users[member].id });
  }
  for (const [key, project] of [["a", "p1"], ["b", "p1"], ["c", "p2"]]) {
    const item = await users.pm.client.rpc("create_work_item", { p_project_id: ids[project], p_type: "TASK", p_title: `${key} ${run}` });
    if (item.error) throw item.error;
    ids[key] = item.data;
  }
  // Each signed-in client must hand its own JWT to Realtime (RLS is evaluated as that user).
  for (const { client } of Object.values(users)) await client.realtime.setAuth();
});

after(async () => {
  for (const { client, channel } of channels) await client.removeChannel(channel);
  await cleanup();
});

test("changes stream to the project's people only, per work item", async () => {
  const anon = createClient(process.env.API_URL, process.env.PUBLISHABLE_KEY ?? process.env.ANON_KEY, { auth: { persistSession: false } });
  const watch = {
    dev: await listen(users.dev.client, ids.a, "dev"),
    pm: await listen(users.pm.client, ids.a, "pm"),
    sa: await listen(users.sa.client, ids.a, "sa"),
    devOnB: await listen(users.dev.client, ids.b, "dev-b"),
    otherdev: await listen(users.otherdev.client, ids.a, "otherdev"),
    outsider: await listen(users.outsider.client, ids.a, "outsider"),
    anon: await listen(anon, ids.a, "anon"),
  };
  for (const name of ["dev", "pm", "sa", "devOnB"]) assert.equal(watch[name].status, "SUBSCRIBED", name);

  const created = await users.member2.client.rpc("create_work_item_comment", { p_work_item_id: ids.a, p_body: "Secret plan for A" });
  assert.equal(created.error, null);
  const id = created.data[0].id;
  assert.ok(await until(() => ["dev", "pm", "sa"].every((name) => watch[name].events.some((event) => event.eventType === "INSERT" && event.new.id === id))),
    "members, the PM and the Super Admin receive the new comment");

  const reply = await users.dev.client.rpc("create_work_item_comment", { p_work_item_id: ids.a, p_body: "Reply", p_parent_comment_id: id });
  assert.equal(reply.error, null);
  assert.ok(await until(() => watch.pm.events.some((event) => event.new?.id === reply.data[0].id && event.new.parent_comment_id === id)), "replies stream too");

  assert.equal((await users.member2.client.rpc("update_work_item_comment", { p_comment_id: id, p_body: "Edited plan" })).error, null);
  assert.ok(await until(() => watch.dev.events.some((event) => event.eventType === "UPDATE" && event.new.id === id && event.new.edited_at)), "edits stream as UPDATE");
  assert.equal((await users.member2.client.rpc("delete_work_item_comment", { p_comment_id: id })).error, null);
  assert.ok(await until(() => watch.dev.events.some((event) => event.eventType === "UPDATE" && event.new.id === id && event.new.deleted_at && event.new.body === null)),
    "soft deletes stream as UPDATE without the text");

  // Other items and other projects.
  const onC = await users.otherdev.client.rpc("create_work_item_comment", { p_work_item_id: ids.c, p_body: "Project two talk" });
  assert.equal(onC.error, null);
  await wait(1_500);
  assert.equal(watch.devOnB.events.length, 0, "a subscription to item B sees nothing from item A");
  for (const name of ["otherdev", "outsider", "anon"]) {
    assert.equal(watch[name].events.length, 0, `${name} receives nothing from project one`);
  }
  assert.ok(![...watch.dev.events, ...watch.pm.events].some((event) => event.new?.id === onC.data[0].id), "nothing leaks across projects");
  await anon.removeAllChannels();
});

test("a member removed from the team stops receiving changes", async () => {
  const watch = await listen(users.member2.client, ids.a, "removed");
  assert.equal(watch.status, "SUBSCRIBED");
  // Control: while still a member, changes arrive.
  const before = await users.dev.client.rpc("create_work_item_comment", { p_work_item_id: ids.a, p_body: "Before removal" });
  assert.ok(await until(() => watch.events.some((event) => event.new?.id === before.data[0].id)), "received while a member");
  const removed = await users.pm.client.rpc("remove_project_member", { p_project_id: ids.p1, p_profile_id: users.member2.id });
  assert.equal(removed.error, null);
  const created = await users.dev.client.rpc("create_work_item_comment", { p_work_item_id: ids.a, p_body: "After removal" });
  assert.equal(created.error, null);
  await wait(1_500);
  assert.ok(!watch.events.some((event) => event.new?.id === created.data[0].id), "RLS is re-checked per change");
});

test("the batched read returns only that item's rows, for readers only", async () => {
  const list = await users.dev.client.rpc("list_work_item_comments", { p_work_item_id: ids.a });
  const onC = await users.otherdev.client.rpc("list_work_item_comments", { p_work_item_id: ids.c });
  const mine = list.data.map((row) => row.id);
  const read = await users.dev.client.rpc("get_work_item_comments", { p_work_item_id: ids.a, p_ids: [...mine, onC.data[0].id] });
  assert.equal(read.error, null);
  assert.deepEqual(read.data.map((row) => row.id).sort(), [...mine].sort(), "other items' ids are ignored");
  assert.equal((await users.outsider.client.rpc("get_work_item_comments", { p_work_item_id: ids.a, p_ids: mine })).error?.code, "P0002");
  const many = Array.from({ length: 51 }, () => mine[0]);
  assert.equal((await users.dev.client.rpc("get_work_item_comments", { p_work_item_id: ids.a, p_ids: many })).error?.message, "invalid_limit");
});
