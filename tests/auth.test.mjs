import assert from "node:assert/strict";
import test from "node:test";

import { getAccess, isActiveProfile } from "../src/features/auth/access.ts";
import { validateCredentials } from "../src/features/auth/validation.ts";

const user = { id: "user-1", user_metadata: { role: "SUPER_ADMIN" } };
const profile = { id: user.id, full_name: "Test Employee", email: "test@example.com", role: "DEVELOPER", is_active: true };

function client({ authUser = user, authError = null, row = profile, queryError = null } = {}) {
  return {
    auth: { getUser: async () => ({ data: { user: authUser }, error: authError }) },
    from(table) {
      assert.equal(table, "profiles");
      return {
        select(columns) {
          assert.equal(columns, "id, full_name, email, role, is_active");
          return {
            eq(column, value) {
              assert.equal(column, "id");
              assert.equal(value, user.id);
              return { maybeSingle: async () => ({ data: row, error: queryError }) };
            },
          };
        },
      };
    },
  };
}

test("all three supported active roles are accepted", () => {
  for (const role of ["SUPER_ADMIN", "PROJECT_MANAGER", "DEVELOPER"]) {
    assert.equal(isActiveProfile({ ...profile, role }, user.id), true);
  }
});

test("missing, inactive, invalid-role, and mismatched profiles are denied", async () => {
  for (const row of [null, { ...profile, is_active: false }, { ...profile, is_active: "true" }, { ...profile, role: "ADMIN" }, { ...profile, id: "another-user" }]) {
    assert.deepEqual(await getAccess(client({ row })), { status: "denied" });
  }
});

test("nullable name and email are allowed", () => {
  assert.equal(isActiveProfile({ ...profile, full_name: null, email: null }, user.id), true);
});

test("metadata cannot promote a developer", async () => {
  const result = await getAccess(client());
  assert.equal(result.status, "authorized");
  assert.equal(result.profile.role, "DEVELOPER");
});

test("profile reads are fresh across calls so deactivation is observed", async () => {
  const row = { ...profile };
  const supabase = client({ row });
  assert.equal((await getAccess(supabase)).status, "authorized");
  row.is_active = false;
  assert.deepEqual(await getAccess(supabase), { status: "denied" });
});

test("anonymous or rejected sessions do not query profiles", async () => {
  for (const options of [{ authUser: null }, { authError: { status: 401 } }]) {
    const supabase = client(options);
    supabase.from = () => assert.fail("must not query profiles without verified identity");
    assert.deepEqual(await getAccess(supabase), { status: "anonymous" });
  }
});

test("Auth and database failures fail closed", async () => {
  assert.deepEqual(await getAccess(client({ authError: { status: 503 } })), { status: "unavailable" });
  assert.deepEqual(await getAccess(client({ queryError: { message: "database unavailable" } })), { status: "unavailable" });
  const supabase = client();
  supabase.auth.getUser = async () => { throw new Error("network failed"); };
  assert.deepEqual(await getAccess(supabase), { status: "unavailable" });
});

test("credentials validate on the server and passwords keep whitespace", () => {
  const form = new FormData();
  assert.equal(typeof validateCredentials(form).error, "string");
  form.set("email", "invalid");
  form.set("password", "password");
  assert.equal(typeof validateCredentials(form).error, "string");
  form.set("email", " employee@example.com ");
  form.set("password", "");
  assert.equal(typeof validateCredentials(form).error, "string");
  form.set("password", "  exact password  ");
  assert.deepEqual(validateCredentials(form), { email: "employee@example.com", password: "  exact password  " });
  form.set("password", "x".repeat(4097));
  assert.equal(typeof validateCredentials(form).error, "string");
});
