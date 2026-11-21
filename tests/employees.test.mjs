import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

import ts from "typescript";

// Source files use extensionless relative imports (bundler resolution).
// Let Node's type stripping resolve them to .ts files for these tests.
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

const dto = await import("../src/features/employees/dto.ts");
const errors = await import("../src/features/employees/errors.ts");
const types = await import("../src/features/employees/types.ts");
const validation = await import("../src/features/employees/validation.ts");

const { parseDirectoryQuery, directoryQueryToParams, normalizeSearch, isUuid } = validation;
const { toDirectoryItem, toAdminDetail, toOwnProfile, totalCount } = dto;
const { EmployeeError, mapDatabaseError } = errors;

const ID = "00000000-0000-4000-a000-000000000001";
const directoryRow = {
  id: ID, full_name: "Alice", avatar_url: null, email: "a@cyclo.test",
  employee_code: null, role: "PROJECT_MANAGER", is_active: true,
};

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------

test("directory query defaults are safe", () => {
  assert.deepEqual(parseDirectoryQuery({}), { search: "", role: null, status: "all", page: 1, pageSize: 20 });
});

test("untrusted query params are bounded and whitelisted", () => {
  const q = parseDirectoryQuery({
    q: ` ${"x".repeat(150)}\u0000 `, role: "ADMIN", status: "deleted", page: "-3", size: "1000",
  });
  assert.equal(q.search.length, 100);
  assert.equal(q.role, null);
  assert.equal(q.status, "all");
  assert.equal(q.page, 1);
  assert.equal(q.pageSize, 20);
  assert.equal(parseDirectoryQuery({ page: "9999999" }).page, 1, "over-long page numbers fall back");
  assert.equal(parseDirectoryQuery({ page: "1e3" }).page, 1);
  assert.equal(parseDirectoryQuery({ page: ["2", "3"] }).page, 1, "repeated params are ignored");
});

test("valid query params are preserved and round-trip", () => {
  const q = parseDirectoryQuery({ q: "  ali  ce ", role: "DEVELOPER", status: "inactive", page: "3", size: "50" });
  assert.deepEqual(q, { search: "ali ce", role: "DEVELOPER", status: "inactive", page: 3, pageSize: 50 });
  assert.deepEqual(parseDirectoryQuery(Object.fromEntries(directoryQueryToParams(q))), q);
  assert.equal(directoryQueryToParams(parseDirectoryQuery({})).toString(), "");
});

test("search keeps LIKE wildcards as literal text (escaped in the database)", () => {
  assert.equal(normalizeSearch("100%_done"), "100%_done");
  assert.equal(normalizeSearch(42), "");
});

test("uuid validation", () => {
  assert.equal(isUuid(ID), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(`${ID}' or 1=1`), false);
});

// ---------------------------------------------------------------------------
// DTO parsing
// ---------------------------------------------------------------------------

test("directory DTO copies only approved fields", () => {
  const item = toDirectoryItem({
    ...directoryRow, invited_by: ID, onboarded_at: "2026-01-01", is_git_organizer: true, created_at: "x", updated_at: "y",
  });
  assert.deepEqual(Object.keys(item).sort(), ["avatarUrl", "email", "employeeCode", "fullName", "id", "isActive", "role"]);
});

test("admin and own-profile DTOs include their extra fields", () => {
  const admin = toAdminDetail({
    ...directoryRow, is_git_organizer: false, invited_by: null, invited_by_name: null,
    onboarded_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
  });
  assert.equal(admin.isGitOrganizer, false);
  assert.equal(admin.createdAt, "2026-01-01T00:00:00Z");
  const own = toOwnProfile({ ...directoryRow, is_git_organizer: true, onboarded_at: null, invited_by: ID });
  assert.deepEqual(Object.keys(own).sort(), ["avatarUrl", "email", "employeeCode", "fullName", "id", "isActive", "isGitOrganizer", "onboardedAt", "role"]);
});

test("malformed rows fail closed", () => {
  for (const row of [null, [], { ...directoryRow, role: "ADMIN" }, { ...directoryRow, is_active: "true" }, { ...directoryRow, id: "" }]) {
    assert.throws(() => toDirectoryItem(row), (e) => e instanceof EmployeeError && e.code === "unexpected");
  }
  assert.throws(() => toAdminDetail(directoryRow), EmployeeError, "admin DTO requires admin fields");
});

test("total count parsing", () => {
  assert.equal(totalCount([]), 0);
  assert.equal(totalCount([{ total_count: 7 }]), 7);
  assert.equal(totalCount([{ total_count: "12" }]), 12);
  assert.throws(() => totalCount([{ total_count: -1 }]), EmployeeError);
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

test("database errors map to safe codes without leaking messages", () => {
  assert.equal(mapDatabaseError({ code: "42501", message: "forbidden" }), "forbidden");
  assert.equal(mapDatabaseError({ code: "42501", message: "unauthenticated" }), "unauthenticated");
  assert.equal(mapDatabaseError({ code: "22023", message: "invalid_page" }), "invalid_input");
  assert.equal(mapDatabaseError({ code: "PGRST301" }), "unauthenticated");
  assert.equal(mapDatabaseError({ code: "08006" }), "unavailable");
  assert.equal(mapDatabaseError({ code: "XX000", message: "relation private.secret does not exist" }), "unexpected");
  assert.equal(mapDatabaseError(null), "unexpected");
  assert.equal(mapDatabaseError({ code: "PGRST202", message: "Could not find the function public.list_employees" }), "unavailable");
  assert.equal(mapDatabaseError({ code: "42883" }), "unavailable");
  const error = new EmployeeError("forbidden");
  assert.doesNotMatch(error.message, /42501|sql|private/i);
});

test("failure diagnostics are a plain string with the code and no raw message", () => {
  const missing = errors.describeDatabaseFailure("list_employees", {
    code: "PGRST202", message: "Could not find the function public.list_employees(p_search => secret-search)",
  });
  assert.equal(typeof missing, "string");
  assert.match(missing, /^\[employees\] list_employees failed: code=PGRST202 \(database function not found/);
  assert.doesNotMatch(missing, /secret-search|Could not find/);
  assert.equal(errors.describeDatabaseFailure("get_employee", { code: "XX000" }), "[employees] get_employee failed: code=XX000");
  assert.equal(errors.describeDatabaseFailure("get_employee", null), "[employees] get_employee failed: code=unknown");
});

// ---------------------------------------------------------------------------
// Server query layer (mocked Supabase; real authorization lives in the DB)
// ---------------------------------------------------------------------------

const source = readFileSync(new URL("../src/features/employees/queries.server.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function queries({ role = "SUPER_ADMIN", rpc }) {
  const calls = [];
  const logs = [];
  const mod = { exports: {} };
  const mocks = {
    "server-only": {},
    "@/features/auth/server": {
      requireActiveProfile: async () => ({ profile: { id: ID, role, is_active: true } }),
    },
    "@/lib/supabase/server": {
      createClient: async () => ({
        rpc: async (name, args) => {
          calls.push({ name, args });
          return rpc(name, args);
        },
      }),
    },
    "./dto": dto,
    "./errors": errors,
    "./types": types,
    "./validation": validation,
  };
  runInNewContext(compiled, {
    module: mod, exports: mod.exports, console: { error: (...args) => logs.push(args) },
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `unexpected dependency ${name}`);
      return mocks[name];
    },
  });
  return { ...mod.exports, calls, logs };
}

const query = parseDirectoryQuery({});

test("developer is rejected before any RPC is made", async () => {
  const q = queries({ role: "DEVELOPER", rpc: () => assert.fail("must not call the database") });
  await assert.rejects(q.listEmployees(query), (e) => e.code === "forbidden");
  await assert.rejects(q.getEmployee(ID), (e) => e.code === "forbidden");
  await assert.rejects(q.adminGetEmployee(ID), (e) => e.code === "forbidden");
});

test("project manager cannot request administrative detail", async () => {
  const q = queries({ role: "PROJECT_MANAGER", rpc: () => assert.fail("must not call the database") });
  await assert.rejects(q.adminGetEmployee(ID), (e) => e.code === "forbidden");
});

test("list maps filters to RPC arguments and returns directory DTOs", async () => {
  const q = queries({
    role: "PROJECT_MANAGER",
    rpc: () => ({ data: [{ ...directoryRow, total_count: 41, is_git_organizer: true }], error: null }),
  });
  const page = await q.listEmployees(parseDirectoryQuery({ q: "ali", role: "DEVELOPER", status: "inactive", page: "2" }));
  // JSON round-trip: the call object was created in the vm realm.
  assert.deepEqual(JSON.parse(JSON.stringify(q.calls[0])), {
    name: "list_employees",
    args: { p_search: "ali", p_role: "DEVELOPER", p_is_active: false, p_page: 2, p_page_size: 20 },
  });
  assert.equal(page.total, 41);
  assert.equal(page.pageCount, 3);
  assert.equal("isGitOrganizer" in page.items[0], false);
});

test("a page past the end still reports the real total", async () => {
  const q = queries({
    rpc: (_name, args) => ({ data: args.p_page === 1 ? [{ ...directoryRow, total_count: 5 }] : [], error: null }),
  });
  const page = await q.listEmployees({ ...query, page: 9 });
  assert.equal(page.items.length, 0);
  assert.equal(page.total, 5);
});

test("RPC errors surface as safe application errors", async () => {
  const q = queries({ rpc: () => ({ data: null, error: { code: "42501", message: "forbidden" } }) });
  await assert.rejects(q.listEmployees(query), (e) => e instanceof EmployeeError && e.code === "forbidden");
});

test("a missing RPC (migration not applied) is reported as unavailable with a readable log line", async () => {
  const q = queries({ rpc: () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }) });
  await assert.rejects(q.listEmployees(query), (e) => e instanceof EmployeeError && e.code === "unavailable");
  assert.equal(q.logs.length, 1);
  assert.equal(q.logs[0].length, 1, "single string argument");
  assert.match(q.logs[0][0], /list_employees failed: code=PGRST202 \(database function not found/);
});

test("expected authorization failures are not logged as errors", async () => {
  const q = queries({ rpc: () => ({ data: null, error: { code: "42501", message: "forbidden" } }) });
  await assert.rejects(q.listEmployees(query));
  assert.equal(q.logs.length, 0);
});

test("invalid ids and missing rows resolve to null without leaking", async () => {
  const q = queries({ rpc: () => ({ data: [], error: null }) });
  assert.equal(await q.getEmployee("../etc"), null);
  assert.equal(q.calls.length, 0, "invalid ids never reach the database");
  assert.equal(await q.adminGetEmployee(ID), null);
});
