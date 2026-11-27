// Integration check of work item comments and mentions (Phase 8G2) through the
// REAL local Supabase HTTP stack: role access, author-only changes, mention
// validation, duplicates, concurrency, pagination and audit. LOCAL ONLY.
//
//   node --env-file=.env.supabase-local --test tests/integration/work-item-comments.local.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { localSql } from "../helpers/local-postgres.mjs";
import { createFixtures, runId } from "../helpers/project-fixtures.mjs";

const run = runId();
const { users, makeUser, cleanup } = createFixtures(`comments-${run}`);
const ids = {};
const tok = (name) => `<@${users[name].id}>`;

const comment = (user, item, body, parent) =>
  users[user].client.rpc("create_work_item_comment", { p_work_item_id: ids[item], p_body: body, p_parent_comment_id: parent });
const list = (user, item, args = {}) => users[user].client.rpc("list_work_item_comments", { p_work_item_id: ids[item], ...args });
const sql = (query) => {
  const result = localSql(query);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
};

before(async () => {
  await makeUser("sa", "SUPER_ADMIN");
  await makeUser("pm1", "PROJECT_MANAGER");
  await makeUser("pm2", "PROJECT_MANAGER");
  await makeUser("dev1", "DEVELOPER");
  await makeUser("dev2", "DEVELOPER");
  await makeUser("dev3", "DEVELOPER");
  await makeUser("outsider", "DEVELOPER");
  for (const [pm, key, devs] of [["pm1", "p1", ["dev1", "dev2"]], ["pm2", "p2", ["dev3"]]]) {
    const project = await users[pm].client.rpc("create_project", { p_name: `Comments ${key} ${run}`, p_project_key: `C${key.toUpperCase()}${run}`.slice(0, 10), p_priority: "medium" });
    if (project.error) throw project.error;
    ids[key] = project.data;
    for (const dev of devs) {
      const member = await users[pm].client.rpc("add_project_member", { p_project_id: ids[key], p_profile_id: users[dev].id });
      if (member.error) throw member.error;
    }
  }
  for (const [pm, project, key, type] of [["pm1", "p1", "story", "STORY"], ["pm1", "p1", "bug", "BUG"], ["pm2", "p2", "other", "TASK"]]) {
    const item = await users[pm].client.rpc("create_work_item", { p_project_id: ids[project], p_type: type, p_title: `${key} ${run}` });
    if (item.error) throw item.error;
    ids[key] = item.data;
  }
});

after(cleanup);

test("Super Admin, assigned PM and member developers can comment; others cannot see the item", async () => {
  for (const user of ["sa", "pm1", "dev1"]) {
    const created = await comment(user, "story", `Hello from ${user}`);
    assert.equal(created.error, null, `${user}: ${created.error?.message}`);
    assert.equal(created.data[0].author_id, users[user].id, "the author is the session user");
  }
  for (const user of ["pm2", "dev3", "outsider"]) {
    const refused = await comment(user, "story", "Let me in");
    assert.equal(refused.error?.code, "P0002", user);
    assert.equal(refused.error?.message, "work_item_not_found", user);
    assert.equal((await list(user, "story")).error?.code, "P0002", `${user} cannot read`);
  }
  const rows = await users.pm2.client.from("work_item_comments").select("id").eq("work_item_id", ids.story);
  assert.deepEqual(rows.data, [], "RLS hides another project's comments from direct reads");
  const direct = await users.dev1.client.from("work_item_comments").insert({ project_id: ids.p1, work_item_id: ids.story, author_id: users.dev2.id, body: "spoof" });
  assert.ok(direct.error, "no direct inserts (and no spoofed authors)");
});

test("bad content is refused; multiline text survives", async () => {
  for (const body of ["", "   \n  ", "x".repeat(5001), "bell\u0007"]) {
    assert.equal((await comment("dev1", "bug", body)).error?.message, "invalid_comment", JSON.stringify(body.slice(0, 10)));
  }
  const created = await comment("dev1", "bug", "Steps:\n1. Open\n2. Click\r\n");
  assert.equal(created.data[0].body, "Steps:\n1. Open\n2. Click");
});

test("mentions: eligible people only, several at once, stored once each", async () => {
  const created = await comment("dev1", "bug", `${tok("dev2")} and ${tok("pm1")} and ${tok("sa")}, again ${tok("dev2")}`);
  assert.equal(created.error, null, created.error?.message);
  ids.mentioned = created.data[0].id;
  assert.deepEqual(created.data[0].mentions.map((mention) => mention.id).sort(), [users.dev2.id, users.pm1.id, users.sa.id].sort());
  assert.equal(sql(`select count(*) from public.work_item_comment_mentions where comment_id = '${ids.mentioned}';`), "3");

  for (const name of ["dev3", "pm2", "outsider"]) {
    assert.equal((await comment("dev1", "bug", `hi ${tok(name)}`)).error?.message, "invalid_mention", name);
  }
  assert.equal((await comment("dev1", "bug", "hi <@00000000-0000-4000-a000-000000000000>")).error?.message, "invalid_mention", "arbitrary id");

  const search = await users.dev1.client.rpc("search_comment_mentions", { p_work_item_id: ids.bug, p_search: run, p_limit: 20 });
  assert.equal(search.error, null);
  assert.deepEqual(search.data.map((row) => row.id).sort(), [users.sa.id, users.pm1.id, users.dev1.id, users.dev2.id].sort(), "Super Admins, the PM and members of this project");
  for (const name of ["pm2", "dev3", "outsider"]) assert.ok(!search.data.some((row) => row.id === users[name].id), `${name} is not offered`);
  assert.ok(!JSON.stringify(search.data).includes("@cyclo.test"), "no emails");
  assert.equal(search.data[0].id, users.pm1.id, "the PM comes first");
});

test("only the author edits or deletes; edits keep surviving mentions", async () => {
  assert.equal((await users.dev2.client.rpc("update_work_item_comment", { p_comment_id: ids.mentioned, p_body: "mine now" })).error?.message, "forbidden");
  assert.equal((await users.pm1.client.rpc("delete_work_item_comment", { p_comment_id: ids.mentioned })).error?.message, "forbidden", "the PM cannot moderate-delete");
  assert.equal((await users.sa.client.rpc("update_work_item_comment", { p_comment_id: ids.mentioned, p_body: "x" })).error?.message, "forbidden");

  const before = sql(`select created_at from public.work_item_comment_mentions where comment_id = '${ids.mentioned}' and profile_id = '${users.pm1.id}';`);
  const edited = await users.dev1.client.rpc("update_work_item_comment", { p_comment_id: ids.mentioned, p_body: `Only ${tok("pm1")} now` });
  assert.equal(edited.error, null);
  assert.ok(edited.data[0].edited_at, "marked edited");
  assert.deepEqual(edited.data[0].mentions.map((mention) => mention.id), [users.pm1.id]);
  assert.equal(sql(`select created_at from public.work_item_comment_mentions where comment_id = '${ids.mentioned}' and profile_id = '${users.pm1.id}';`), before, "no duplicate mention for someone already mentioned");

  const deleted = await users.dev1.client.rpc("delete_work_item_comment", { p_comment_id: ids.mentioned });
  assert.deepEqual([deleted.data[0].body, Boolean(deleted.data[0].deleted_at)], [null, true]);
  assert.equal(sql(`select count(*) from public.work_item_comment_mentions where comment_id = '${ids.mentioned}';`), "0");
});

test("replies are one level deep and stay on their thread", async () => {
  const parent = await comment("pm1", "bug", "Thread start");
  ids.thread = parent.data[0].id;
  const reply = await comment("dev2", "bug", "A reply", ids.thread);
  assert.equal(reply.data[0].parent_comment_id, ids.thread);
  assert.equal((await comment("dev1", "bug", "Nested", reply.data[0].id)).error?.message, "invalid_parent_comment");
  assert.equal((await comment("pm1", "story", "Elsewhere", ids.thread)).error?.message, "invalid_parent_comment");
  const listed = await list("dev1", "bug");
  const position = listed.data.findIndex((row) => row.id === ids.thread);
  assert.equal(listed.data[position + 1].id, reply.data[0].id, "the reply follows its thread");
  assert.equal(listed.data[position].reply_count, 1);
});

test("duplicate and conflicting changes are safe", async () => {
  const created = await comment("dev2", "bug", "Will be deleted twice");
  const id = created.data[0].id;
  const deletes = await Promise.all([1, 2].map(() => users.dev2.client.rpc("delete_work_item_comment", { p_comment_id: id })));
  assert.ok(deletes.every((result) => !result.error), JSON.stringify(deletes.map((result) => result.error)));
  assert.equal(sql(`select count(*) from private.project_audit_log where action = 'WORK_ITEM_COMMENT_DELETED' and new_values ->> 'comment_id' = '${id}';`), "1", "one deletion event");

  const raced = (await comment("dev2", "bug", "Edit or delete?")).data[0].id;
  const results = await Promise.all([
    users.dev2.client.rpc("update_work_item_comment", { p_comment_id: raced, p_body: "Edited" }),
    users.dev2.client.rpc("delete_work_item_comment", { p_comment_id: raced }),
  ]);
  const deletedFirst = results[0].error?.message === "comment_deleted";
  assert.ok(deletedFirst || !results[0].error, JSON.stringify(results[0].error));
  assert.equal(results[1].error, null);
  assert.equal(sql(`select body is null and deleted_at is not null from public.work_item_comments where id = '${raced}';`), "t", "the delete always wins in the end");
});

test("long discussions page oldest first without overlap", async () => {
  for (let n = 1; n <= 5; n += 1) assert.equal((await comment("dev1", "story", `Paged ${n}`)).error, null);
  const all = await list("dev1", "story", { p_reply_limit: 0, p_limit: 51 });
  const pages = [];
  let cursor = {};
  for (;;) {
    const page = await list("dev1", "story", { p_reply_limit: 0, p_limit: 3, ...cursor });
    assert.equal(page.error, null);
    pages.push(...page.data.map((row) => row.id));
    if (page.data.length < 3) break;
    const last = page.data[page.data.length - 1];
    cursor = { p_after_created_at: last.created_at, p_after_id: last.id };
  }
  assert.deepEqual(pages, all.data.map((row) => row.id));
  const times = all.data.map((row) => Date.parse(row.created_at));
  assert.deepEqual([...times].sort((a, b) => a - b), times, "chronological");
});

test("audit events carry ids and counts, never the text", async () => {
  const rows = sql(`select string_agg(new_values::text, '|') from private.project_audit_log where project_id = '${ids.p1}' and action like 'WORK_ITEM_COMMENT_%';`);
  assert.ok(rows.includes("comment_id"));
  for (const text of ["Thread start", "Steps:", "Paged 1", "Only "]) assert.ok(!rows.includes(text), text);
  const history = await users.dev1.client.rpc("list_project_activity", { p_project_id: ids.p1, p_limit: 100, p_work_item_id: ids.bug });
  assert.ok(history.data.some((row) => row.action === "WORK_ITEM_COMMENT_ADDED"), "comment events appear in the item's history");
});
