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

const comments = await import("../src/features/comments/logic.ts");
const activity = await import("../src/features/projects/activity.ts");
const { mapProjectDatabaseError, ProjectError } = await import("../src/features/projects/errors.ts");

const {
  toComment, toCommentPage, toReplyPage, toMentionCandidate, isCommentCursor, bodySegments, toEditorText, toStoredBody,
  mentionedIds, validateStoredBody, mentionQueryAt, insertMention, COMMENT_MAX, COMMENT_PAGE_SIZE, MENTION_MAX,
} = comments;

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../supabase/migrations/20261203100000_work_item_comments.sql");
const actions = read("../src/features/comments/actions.ts");

const ME = "00000000-0000-4000-a000-000000000001";
const DEV = "00000000-0000-4000-a000-000000000002";
const PM = "00000000-0000-4000-a000-000000000003";
const ITEM = "00000000-0000-4000-a000-0000000000b1";
const id = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

const row = (overrides = {}) => ({
  id: id(100), work_item_id: ITEM, parent_comment_id: null, author_id: ME, author_name: " Priya Manager ",
  author_avatar_kind: "emoji", author_avatar_symbol: "rocket", body: "Hello", created_at: "2026-12-03T10:00:00Z",
  edited_at: null, deleted_at: null, reply_count: 0, mentions: [], email: "leak@example.com", ...overrides,
});

// ---------------------------------------------------------------------------
// Database contract
// ---------------------------------------------------------------------------

test("one comments table with one-level replies, structural mentions and database validation", () => {
  assert.match(migration, /create table public\.work_item_comments/);
  assert.match(migration, /create table public\.work_item_comment_mentions/);
  assert.equal((migration.match(/create table /g) ?? []).length, 2, "no other tables");
  assert.match(migration, /foreign key \(project_id, work_item_id\)\s+references public\.work_items \(project_id, id\)/, "comment ↔ item ↔ project");
  assert.match(migration, /foreign key \(work_item_id, parent_comment_id\)\s+references public\.work_item_comments \(work_item_id, id\)/, "replies stay on the same item");
  assert.match(migration, /message = 'invalid_parent_comment', constraint = 'work_item_comments_one_level'/, "one level only");
  assert.match(migration, /char_length\(body\) between 1 and 5000/);
  assert.match(migration, /primary key \(comment_id, profile_id\)/, "one mention row per person");
  for (const index of ["work_item_comments_thread_idx", "work_item_comments_replies_idx", "work_item_comment_mentions_profile_idx"]) {
    assert.match(migration, new RegExp(`create index ${index}`));
  }
});

test("authors and permissions come from the session; the client never sends them", () => {
  assert.match(migration, /values \(v_access\.project_id, p_work_item_id, p_parent_comment_id, v_access\.actor_id, v_body\)/, "author = caller, project = item's project");
  assert.match(migration, /if v_author <> actor_id then\s+raise exception using errcode = '42501', message = 'forbidden'/, "author-only edit/delete");
  assert.match(migration, /if not private\.is_comment_mentionable\(p_project_id, v_id\) then\s+raise exception using errcode = '22023', message = 'invalid_mention'/);
  assert.match(migration, /revoke all on table public\.work_item_comments from public, anon, authenticated, service_role, cyclo_project_api/);
  assert.doesNotMatch(migration, /grant (insert|update|delete)[^;]*on table public\.work_item_comment[^;]* to authenticated/i, "no direct writes");
  assert.doesNotMatch(migration, /grant select on table public\.work_item_comment_mentions to authenticated/, "mentions are read through the RPCs");
  for (const name of ["createCommentAction", "updateCommentAction"]) {
    const body = actions.slice(actions.indexOf(`export async function ${name}`));
    const signature = body.slice(0, body.indexOf("Promise<CommentResult>"));
    assert.doesNotMatch(signature, /authorId|projectId|role|userId/, `${name} takes no identity input`);
  }
});

test("audit events never carry the comment text", () => {
  const audits = [...migration.matchAll(/'WORK_ITEM_COMMENT_(ADDED|EDITED|DELETED)', '\{\}'::jsonb,\s*pg_catalog\.jsonb_build_object\(([^;]*)\);/g)];
  assert.equal(audits.length, 3);
  for (const [, , values] of audits) assert.doesNotMatch(values, /body/, "no body in audit values");
  for (const action of ["WORK_ITEM_COMMENT_ADDED", "WORK_ITEM_COMMENT_EDITED", "WORK_ITEM_COMMENT_DELETED"]) {
    assert.ok(activity.ACTIVITY_ACTIONS.includes(action), action);
  }
  const item = { work_item_id: ITEM, work_item_key: "CPR-3", work_item_title: "Login" };
  const said = (action) => activity.describeActivity(activity.toActivityEntry({
    id: id(1), action, created_at: "2026-12-03T10:00:00Z", actor_id: ME, actor_name: "Priya", changes: [], ...item,
  }));
  assert.equal(said("WORK_ITEM_COMMENT_ADDED"), "commented on CPR-3");
  assert.equal(said("WORK_ITEM_COMMENT_EDITED"), "edited a comment on CPR-3");
  assert.equal(said("WORK_ITEM_COMMENT_DELETED"), "deleted a comment on CPR-3");
});

test("comment errors map to safe codes", () => {
  assert.equal(mapProjectDatabaseError({ code: "22023", message: "invalid_comment" }), "invalid_comment");
  assert.equal(mapProjectDatabaseError({ code: "22023", message: "invalid_mention" }), "invalid_mention");
  assert.equal(mapProjectDatabaseError({ code: "22023", message: "too_many_mentions" }), "too_many_mentions");
  assert.equal(mapProjectDatabaseError({ code: "22023", message: "invalid_parent_comment" }), "invalid_parent_comment");
  assert.equal(mapProjectDatabaseError({ code: "P0002", message: "comment_not_found" }), "comment_not_found");
  assert.equal(mapProjectDatabaseError({ code: "P0002", message: "work_item_not_found" }), "not_found");
  assert.equal(mapProjectDatabaseError({ code: "55000", message: "comment_deleted" }), "comment_deleted");
  assert.equal(mapProjectDatabaseError({ code: "42501", message: "forbidden" }), "forbidden");
});

// ---------------------------------------------------------------------------
// Rows and paging
// ---------------------------------------------------------------------------

test("rows parse into comments without extra fields; malformed rows fail closed", () => {
  const comment = toComment(row({ mentions: [{ id: DEV.toUpperCase(), name: "Dev Kumar" }] }));
  assert.deepEqual(Object.keys(comment).sort(), ["authorAvatar", "authorId", "authorName", "body", "createdAt", "deletedAt", "editedAt", "id", "mentions", "parentId", "replyCount", "workItemId"]);
  assert.equal(comment.authorName, "Priya Manager");
  assert.deepEqual(comment.authorAvatar, { type: "emoji", id: "rocket" });
  assert.deepEqual(comment.mentions, [{ id: DEV, name: "Dev Kumar" }], "ids are normalised");
  const photo = toComment(row(), new Map([[ME, { type: "image", src: "https://example.supabase.co/x" }]]));
  assert.equal(photo.authorAvatar.type, "image", "server-resolved avatars win");
  assert.equal(toComment(row({ body: null, deleted_at: "2026-12-03T11:00:00Z" })).body, null);
  for (const bad of [row({ body: null }), row({ deleted_at: "2026-12-03T11:00:00Z" }), row({ author_id: "me" }), row({ reply_count: -1 }), row({ created_at: "soon" }), row({ mentions: "x" }), null]) {
    assert.throws(() => toComment(bad), ProjectError);
  }
});

test("threads group replies; the extra thread becomes the cursor", () => {
  const top = (n, replyCount = 0) => toComment(row({ id: id(n), created_at: `2026-12-03T10:${String(n).padStart(2, "0")}:00Z`, reply_count: replyCount }));
  const reply = (n, parent) => toComment(row({ id: id(n), parent_comment_id: id(parent), created_at: `2026-12-03T11:${String(n % 60).padStart(2, "0")}:00Z` }));
  const page = toCommentPage([top(1, 2), reply(50, 1), reply(51, 1), top(2), top(3)], 2);
  assert.deepEqual(page.threads.map((thread) => thread.comment.id), [id(1), id(2)]);
  assert.deepEqual(page.threads[0].replies.map((entry) => entry.id), [id(50), id(51)]);
  assert.deepEqual(page.nextCursor, { createdAt: "2026-12-03T10:02:00Z", id: id(2) });
  assert.equal(toCommentPage([top(1)], 2).nextCursor, null);

  const truncated = toCommentPage([top(1, 5), reply(50, 1), reply(51, 1)], 20, 2);
  assert.deepEqual(truncated.threads[0].repliesCursor, { createdAt: truncated.threads[0].replies[1].createdAt, id: id(51) }, "more replies to load");
  assert.equal(toCommentPage([top(1, 2), reply(50, 1), reply(51, 1)], 20, 2).threads[0].repliesCursor, null, "all replies shown");
  assert.throws(() => toCommentPage([reply(50, 9)]), ProjectError, "orphan replies fail closed");

  const replies = toReplyPage([reply(60, 1), reply(61, 1), reply(62, 1)], 2);
  assert.equal(replies.replies.length, 2);
  assert.equal(replies.nextCursor.id, id(61));
  assert.equal(COMMENT_PAGE_SIZE, 20);
});

test("cursors and mention candidates are validated", () => {
  assert.equal(isCommentCursor({ createdAt: "2026-12-03T10:00:00Z", id: ME }), true);
  for (const bad of [null, "x", { createdAt: "x", id: ME }, { createdAt: "2026-12-03T10:00:00Z", id: "1; drop" }]) assert.equal(isCommentCursor(bad), false);
  const candidate = toMentionCandidate({ id: PM, full_name: " Priya ", role: "PROJECT_MANAGER", avatar_kind: "default", avatar_symbol: null, is_project_manager: true, email: "x@y" });
  assert.deepEqual(candidate, { id: PM, name: "Priya", role: "PROJECT_MANAGER", isProjectManager: true, avatar: { type: "initials" } });
  assert.throws(() => toMentionCandidate({ id: PM, full_name: null, role: "DEVELOPER", is_project_manager: false }), ProjectError);
  assert.throws(() => toMentionCandidate({ id: PM, full_name: "X", role: "OWNER", is_project_manager: false }), ProjectError);
});

// ---------------------------------------------------------------------------
// Body ⇄ editor text
// ---------------------------------------------------------------------------

test("stored bodies render as text and mention segments", () => {
  const body = `Hi <@${DEV.toUpperCase()}>,\nplease check with <@${PM}> and <@${id(999)}>.`;
  assert.deepEqual(bodySegments(body, [{ id: DEV, name: "Dev Kumar" }, { id: PM, name: "Priya" }]), [
    { type: "text", text: "Hi " },
    { type: "mention", id: DEV, name: "Dev Kumar" },
    { type: "text", text: ",\nplease check with " },
    { type: "mention", id: PM, name: "Priya" },
    { type: "text", text: " and " },
    { type: "mention", id: id(999), name: null },
    { type: "text", text: "." },
  ]);
  assert.deepEqual(bodySegments("<script>x</script>", []), [{ type: "text", text: "<script>x</script>" }], "markup is text");
});

test("editor text converts to tokens only for picked people, longest names first", () => {
  const picked = [{ id: DEV, name: "Dev" }, { id: PM, name: "Dev Kumar" }];
  assert.equal(toStoredBody("@Dev Kumar and @Dev, thanks", picked), `<@${PM}> and <@${DEV}>, thanks`);
  assert.equal(toStoredBody("mail me at a@Dev please", picked), "mail me at a@Dev please", "inside a word is not a mention");
  assert.equal(toStoredBody("@Devon and @Dev", picked), `@Devon and <@${DEV}>`, "a longer word is not a mention");
  assert.equal(toStoredBody("@Someone typed by hand", picked), "@Someone typed by hand");
  assert.equal(toStoredBody("@Dev @Dev\r\n", picked), `<@${DEV}> <@${DEV}>`, "repeats stay; CRLF normalised; trimmed");
  assert.deepEqual(mentionedIds(`<@${DEV}> <@${DEV.toUpperCase()}> <@${PM}>`), [DEV, PM], "distinct ids");

  const { text, picked: again } = toEditorText(`Hi <@${PM}>`, [{ id: PM, name: "Dev Kumar" }]);
  assert.equal(text, "Hi @Dev Kumar");
  assert.equal(toStoredBody(text, again), `Hi <@${PM}>`, "round trip");
});

test("client validation mirrors the database limits", () => {
  assert.equal(validateStoredBody("   "), "empty");
  assert.equal(validateStoredBody("x".repeat(COMMENT_MAX)), null);
  assert.equal(validateStoredBody("x".repeat(COMMENT_MAX + 1)), "too_long");
  const many = Array.from({ length: MENTION_MAX + 1 }, (_, n) => `<@${id(n + 1)}>`).join(" ");
  assert.equal(validateStoredBody(many), "too_many_mentions");
  assert.match(migration, /cardinality\(v_ids\) > 20/);
});

test("the autocomplete finds the @query at the caret and inserts the name", () => {
  assert.deepEqual(mentionQueryAt("Hi @Pri", 7), { start: 3, query: "Pri" });
  assert.deepEqual(mentionQueryAt("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionQueryAt("(@Dev Ku", 8), { start: 1, query: "Dev Ku" }, "names have spaces");
  assert.equal(mentionQueryAt("mail a@b", 8), null, "not inside a word");
  assert.equal(mentionQueryAt("@ dev", 5), null, "not after a space");
  assert.equal(mentionQueryAt("@dev\nnext", 9), null, "not across lines");
  assert.equal(mentionQueryAt("no mention", 10), null);

  const text = "Thanks @Pri for this";
  const query = mentionQueryAt(text, 11);
  assert.deepEqual(insertMention(text, 11, query, "Priya Manager"), { text: "Thanks @Priya Manager for this", caret: 22 });
  assert.deepEqual(insertMention("@", 1, { start: 0, query: "" }, "Dev"), { text: "@Dev ", caret: 5 });
});
