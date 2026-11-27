// Shared setup for the project integration tests (LOCAL Supabase only).
// Creates throwaway users through the Admin API and removes them, their
// projects and memberships afterwards. Projects cannot be deleted through any
// API role, so cleanup runs as the table owner via the local database container.
import { randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { localSql } from "./local-postgres.mjs";

const url = process.env.API_URL;
const anonKey = process.env.PUBLISHABLE_KEY ?? process.env.ANON_KEY;
const serviceKey = process.env.SECRET_KEY ?? process.env.SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) throw new Error("Load `supabase status -o env` output first.");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("Refusing to run against a non-local Supabase URL.");
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };
export const admin = createClient(url, serviceKey, options);

/** Upper-case run id (letters only) so generated project keys stay valid. */
export function runId() {
  return randomUUID().slice(0, 4).toUpperCase().replace(/[^A-Z]/g, "X");
}

export function createFixtures(prefix) {
  const users = {};

  async function makeUser(name, role, { isActive = true } = {}) {
    const email = `it-${prefix}-${name}@cyclo.test`.toLowerCase();
    const password = randomBytes(24).toString("base64url");
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { role: "SUPER_ADMIN" } });
    if (error) throw error;
    const id = data.user.id;
    const { error: updateError } = await admin.from("profiles").update({ role, is_active: true, full_name: `IT ${name} ${prefix}` }).eq("id", id);
    if (updateError) throw updateError;
    const client = createClient(url, anonKey, options);
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    if (!isActive) {
      const { error: deactivateError } = await admin.from("profiles").update({ is_active: false }).eq("id", id);
      if (deactivateError) throw deactivateError;
    }
    users[name] = { id, client };
    return users[name];
  }

  async function cleanup() {
    const ids = Object.values(users).map(({ id }) => id).filter((id) => /^[0-9a-f-]{36}$/.test(id));
    if (ids.length) {
      const list = ids.map((id) => `'${id}'`).join(",");
      // Work items: leaf types first (parent links are ON DELETE RESTRICT).
      const items = `project_id in (select id from public.projects where project_manager_id in (${list}) or created_by in (${list}))`;
      const result = localSql(`begin;
        alter table public.work_item_comments disable trigger work_item_comments_prevent_delete;
        delete from public.work_item_comments where ${items} and parent_comment_id is not null;
        delete from public.work_item_comments where ${items};
        alter table public.work_item_comments enable always trigger work_item_comments_prevent_delete;
        alter table public.work_items disable trigger work_items_prevent_delete;
        delete from public.work_items where ${items} and type = 'SUBTASK';
        delete from public.work_items where ${items} and type = 'BUG';
        delete from public.work_items where ${items} and type = 'TASK';
        delete from public.work_items where ${items} and type = 'STORY';
        delete from public.work_items where ${items} and type = 'EPIC';
        alter table public.work_items enable trigger work_items_prevent_delete;
        alter table public.sprints disable trigger sprints_prevent_delete;
        delete from public.sprints where ${items};
        alter table public.sprints enable trigger sprints_prevent_delete;
        alter table public.projects disable trigger projects_prevent_delete;
        delete from public.projects where project_manager_id in (${list}) or created_by in (${list});
        alter table public.projects enable trigger projects_prevent_delete;
        delete from public.project_members where profile_id in (${list}) or added_by in (${list});
        delete from private.project_audit_log where actor_id in (${list});
        update public.profiles set role = 'DEVELOPER' where id in (${list});
        commit;`);
      if (result.code !== 0) console.error(result.stderr);
    }
    for (const { id, client } of Object.values(users)) {
      await client.auth.signOut();
      await admin.auth.admin.deleteUser(id);
    }
  }

  return { users, makeUser, cleanup };
}
