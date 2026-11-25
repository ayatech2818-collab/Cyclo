import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// Source files use extensionless relative imports (bundler resolution).
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

const validation = await import("../src/features/projects/validation.ts");
const errors = await import("../src/features/projects/errors.ts");
const dto = await import("../src/features/projects/dto.ts");
const types = await import("../src/features/projects/types.ts");
const format = await import("../src/features/projects/format.ts");

const {
  suggestProjectKey, normalizeProjectKey, validateCreateProject, validateUpdateProject, parseProjectListQuery,
  projectQueryToParams, projectsHref, canCreateProjects, canManageProject, canAssignProjectManager, isIsoDate, PROJECT_KEY_PATTERN,
} = validation;
const { mapProjectDatabaseError, ProjectError, PROJECT_ERROR_FIELDS } = errors;

const PM = "00000000-0000-4000-a000-000000000002";
const migration = readFileSync(new URL("../supabase/migrations/20261125100000_projects_foundation.sql", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// Project keys
// ---------------------------------------------------------------------------

test("key suggestions follow the key format", () => {
  assert.equal(suggestProjectKey("Customer Portal Revamp"), "CPR");
  assert.equal(suggestProjectKey("Cyclone"), "CYCL");
  assert.equal(suggestProjectKey("AI"), "AI");
  assert.equal(suggestProjectKey("x"), "XP");
  assert.equal(suggestProjectKey("2026 Website Refresh"), "WR", "leading numbers are skipped");
  assert.equal(suggestProjectKey("Café Ordering App"), "COA", "accents are folded");
  assert.equal(suggestProjectKey("One Two Three Four Five Six"), "OTTF", "at most four initials");
  for (const name of ["", "   ", "123", "!!!", null, 42]) assert.equal(suggestProjectKey(name), "", String(name));
  for (const name of ["Web", "a b", "Q3 planning", "Über-Analytics Platform v2", "x".repeat(200)]) {
    const key = suggestProjectKey(name);
    assert.match(key, PROJECT_KEY_PATTERN, name);
  }
});

test("keys are trimmed and upper-cased", () => {
  assert.equal(normalizeProjectKey("  web1 "), "WEB1");
  assert.equal(normalizeProjectKey(undefined), "");
});

// ---------------------------------------------------------------------------
// Form validation
// ---------------------------------------------------------------------------

const valid = { name: "  Web Platform ", projectKey: "web", priority: "high", description: "  ", startDate: "2026-12-01", targetDate: "2027-03-01" };

test("Super Admin create requires a PM; values are normalized", () => {
  const missing = validateCreateProject(valid, { requireManager: true });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.projectManagerId);

  const ok = validateCreateProject({ ...valid, projectManagerId: PM.toUpperCase() }, { requireManager: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.values, {
    name: "Web Platform", description: null, priority: "high", startDate: "2026-12-01", targetDate: "2027-03-01",
    projectKey: "WEB", projectManagerId: PM,
  });
});

test("Project Manager create ignores any submitted PM id (assigned by the database)", () => {
  const result = validateCreateProject({ ...valid, projectManagerId: PM }, { requireManager: false });
  assert.equal(result.ok, true);
  assert.equal(result.values.projectManagerId, null);
});

test("required fields and formats are validated", () => {
  const result = validateCreateProject({ name: " ", projectKey: "1AB", priority: "urgent" }, { requireManager: false });
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result.errors).sort(), ["name", "priority", "projectKey"]);
  assert.equal(validateCreateProject({ ...valid, projectKey: "" }, { requireManager: false }).errors.projectKey, "Project key is required.");
  assert.ok(validateCreateProject({ ...valid, projectKey: "ABCDEFGHIJK" }, { requireManager: false }).errors.projectKey);
  assert.ok(validateCreateProject({ ...valid, projectKey: "A-B" }, { requireManager: false }).errors.projectKey);
  assert.ok(validateCreateProject({ ...valid, name: "Line\nbreak" }, { requireManager: false }).errors.name);
  assert.ok(validateCreateProject({ ...valid, name: "x".repeat(121) }, { requireManager: false }).errors.name);
  assert.ok(validateCreateProject({ ...valid, description: "x".repeat(5001) }, { requireManager: false }).errors.description);
});

test("invalid dates are rejected", () => {
  const reversed = validateCreateProject({ ...valid, startDate: "2027-02-01", targetDate: "2027-01-01" }, { requireManager: false });
  assert.equal(reversed.ok, false);
  assert.match(reversed.errors.targetDate, /on or after/);
  assert.equal(validateCreateProject({ ...valid, startDate: "2027-01-01", targetDate: "2027-01-01" }, { requireManager: false }).ok, true, "same day is allowed");
  assert.ok(validateCreateProject({ ...valid, startDate: "2027-02-30" }, { requireManager: false }).errors.startDate);
  assert.ok(validateCreateProject({ ...valid, targetDate: "01/02/2027" }, { requireManager: false }).errors.targetDate);
  assert.equal(validateCreateProject({ ...valid, startDate: "", targetDate: "" }, { requireManager: false }).values.startDate, null);
  assert.equal(isIsoDate("2028-02-29"), true);
  assert.equal(isIsoDate("2027-02-29"), false);
});

test("update requires a valid status", () => {
  assert.ok(validateUpdateProject({ ...valid, status: "archived" }).errors.status);
  const result = validateUpdateProject({ ...valid, status: "on_hold" });
  assert.equal(result.ok, true);
  assert.equal(result.values.status, "on_hold");
  assert.equal("projectKey" in result.values, false, "keys are never sent on update");
});

// ---------------------------------------------------------------------------
// Permissions (UI gates mirror the database rules)
// ---------------------------------------------------------------------------

test("creation is limited to Super Admins and Project Managers", () => {
  assert.equal(canCreateProjects("SUPER_ADMIN"), true);
  assert.equal(canCreateProjects("PROJECT_MANAGER"), true);
  assert.equal(canCreateProjects("DEVELOPER"), false);
});

test("management: Super Admin any project, PM only assigned projects, Developer none", () => {
  const project = { projectManagerId: PM };
  assert.equal(canManageProject({ id: "sa", role: "SUPER_ADMIN" }, project), true);
  assert.equal(canManageProject({ id: PM, role: "PROJECT_MANAGER" }, project), true);
  assert.equal(canManageProject({ id: "other-pm", role: "PROJECT_MANAGER" }, project), false);
  assert.equal(canManageProject({ id: PM, role: "DEVELOPER" }, project), false);
  assert.equal(canAssignProjectManager("SUPER_ADMIN"), true);
  assert.equal(canAssignProjectManager("PROJECT_MANAGER"), false);
});

// ---------------------------------------------------------------------------
// Listing query
// ---------------------------------------------------------------------------

test("list query defaults and untrusted params", () => {
  assert.deepEqual(parseProjectListQuery({}), {
    search: "", status: null, priority: null, archived: false, sort: "updated_desc", view: "grid", page: 1, pageSize: 12,
  });
  const hostile = parseProjectListQuery({
    q: ` ${"x".repeat(150)}\u0000 `, status: "deleted", priority: "urgent", archived: "true", sort: "id;drop", view: "table", page: "-1", size: "1000",
  });
  assert.equal(hostile.search.length, 100);
  assert.equal(hostile.status, null);
  assert.equal(hostile.priority, null);
  assert.equal(hostile.archived, false);
  assert.equal(hostile.sort, "updated_desc");
  assert.equal(hostile.view, "grid");
  assert.equal(hostile.page, 1);
  assert.equal(hostile.pageSize, 12);
});

test("list query round-trips through the URL", () => {
  const query = parseProjectListQuery({ q: " web ", status: "active", priority: "critical", archived: "1", sort: "name_asc", view: "list", page: "3", size: "24" });
  assert.deepEqual(parseProjectListQuery(Object.fromEntries(projectQueryToParams(query))), query);
  assert.equal(projectsHref(parseProjectListQuery({})), "/projects");
  assert.equal(projectsHref(query, { page: 1, archived: false }), "/projects?q=web&status=active&priority=critical&sort=name_asc&view=list&size=24");
});

test("allow-listed sorts match the database function", () => {
  for (const sort of types.PROJECT_SORTS) assert.ok(migration.includes(`'${sort}'`), sort);
  for (const status of types.PROJECT_STATUSES) assert.ok(migration.includes(`'${status}'`), status);
});

// ---------------------------------------------------------------------------
// Errors and DTOs
// ---------------------------------------------------------------------------

test("database errors map to safe codes and form fields", () => {
  assert.equal(mapProjectDatabaseError({ code: "42501", message: "forbidden" }), "forbidden");
  assert.equal(mapProjectDatabaseError({ code: "42501", message: "unauthenticated" }), "unauthenticated");
  assert.equal(mapProjectDatabaseError({ code: "P0002", message: "project_not_found" }), "not_found");
  assert.equal(mapProjectDatabaseError({ code: "23505", message: "duplicate key value violates unique constraint" }), "duplicate_project_key");
  assert.equal(mapProjectDatabaseError({ code: "55000", message: "project_archived" }), "project_archived");
  assert.equal(mapProjectDatabaseError({ code: "22023", message: "invalid_date_range" }), "invalid_date_range");
  assert.equal(mapProjectDatabaseError({ code: "22023", message: "something else" }), "invalid_input");
  assert.equal(mapProjectDatabaseError({ code: "23514", message: "invalid_project_manager" }), "invalid_project_manager");
  assert.equal(mapProjectDatabaseError({ code: "PGRST202" }), "unavailable");
  assert.equal(mapProjectDatabaseError({ code: "XX000", message: "secret internals" }), "unexpected");
  assert.equal(mapProjectDatabaseError(null), "unexpected");
  assert.equal(PROJECT_ERROR_FIELDS.duplicate_project_key, "projectKey");
  assert.equal(PROJECT_ERROR_FIELDS.invalid_date_range, "targetDate");
  assert.doesNotMatch(new ProjectError("unexpected").message, /secret|SQL/i);
});

const row = {
  id: "00000000-0000-4000-a000-0000000000aa", name: "Web", project_key: "WEB", description: null,
  status: "active", priority: "high", project_manager_id: PM, project_manager_name: "Pat",
  start_date: "2026-12-01", target_date: null, created_at: "2026-11-25T10:00:00+00:00",
  updated_at: "2026-11-25T10:00:00+00:00", archived_at: null, total_count: 7, secret_column: "leak",
};

test("list rows are parsed into DTOs without extra fields", () => {
  const item = dto.toProjectListItem(row);
  assert.equal(item.projectKey, "WEB");
  assert.equal("secret_column" in item, false);
  assert.equal("total_count" in item, false);
  assert.equal(dto.projectTotalCount([row]), 7);
  assert.equal(dto.projectTotalCount([]), 0);
  assert.throws(() => dto.toProjectListItem({ ...row, status: "archived" }), ProjectError);
  assert.throws(() => dto.toProjectListItem({ ...row, id: 5 }), ProjectError);
  assert.throws(() => dto.projectTotalCount([{ ...row, total_count: -1 }]), ProjectError);
});

test("detail rows require PM status and creator", () => {
  const detail = dto.toProjectDetail({ ...row, project_manager_email: "pat@cyclo.test", project_manager_is_active: false, created_by: PM, created_by_name: null });
  assert.equal(detail.projectManagerIsActive, false);
  assert.throws(() => dto.toProjectDetail(row), ProjectError);
});

test("dates format deterministically in UTC", () => {
  assert.equal(format.formatProjectDate("2026-12-01"), "1 Dec 2026");
  assert.equal(format.formatDateRange("2026-12-01", "2027-03-01"), "1 Dec 2026 → 1 Mar 2027");
  assert.equal(format.formatDateRange(null, "2027-03-01"), "Due 1 Mar 2027");
  assert.equal(format.formatDateRange(null, null), null);
  assert.equal(format.formatProjectDate("nonsense"), null);
});

// ---------------------------------------------------------------------------
// Static guarantees
// ---------------------------------------------------------------------------

test("project UI never imports the admin (secret key) client", () => {
  for (const file of ["actions.ts", "queries.server.ts", "mutations.server.ts", "components/project-form.tsx", "components/project-manage.tsx"]) {
    const source = readFileSync(new URL(`../src/features/projects/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /admin\.server|SECRET_KEY|service_role/i, file);
  }
});

test("mutations never send an actor id or role to the database", () => {
  const source = readFileSync(new URL("../src/features/projects/mutations.server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /p_actor|p_role|created_by/);
});

test("migration blocks hard deletes and keeps project keys immutable", () => {
  assert.match(migration, /create trigger projects_prevent_delete/);
  assert.match(migration, /project_key_immutable/);
  assert.doesNotMatch(migration, /grant[^;]*delete[^;]*on table public\.projects/i);
});

// ---------------------------------------------------------------------------
// Phase 8B: team membership
// ---------------------------------------------------------------------------

test("membership errors map to specific, safe messages", () => {
  assert.equal(mapProjectDatabaseError({ code: "23505", message: "duplicate_member" }), "duplicate_member");
  assert.equal(mapProjectDatabaseError({ code: "23505", message: "duplicate_project_key" }), "duplicate_project_key");
  assert.equal(mapProjectDatabaseError({ code: "22023", message: "invalid_member" }), "invalid_member");
  assert.equal(mapProjectDatabaseError({ code: "23514", message: "invalid_member" }), "invalid_member");
  assert.equal(mapProjectDatabaseError({ code: "P0002", message: "member_not_found" }), "member_not_found");
  assert.equal(mapProjectDatabaseError({ code: "P0002", message: "project_not_found" }), "not_found");
  assert.match(new ProjectError("invalid_member").message, /active developers/);
});

const memberRow = {
  id: "00000000-0000-4000-a000-0000000000bb", profile_id: "00000000-0000-4000-a000-0000000000cc",
  full_name: null, email: "dev@cyclo.test", role: "DEVELOPER", is_active: false,
  added_by: PM, added_by_name: "Pat", created_at: "2026-11-26T10:00:00+00:00", password_hash: "leak",
};

test("member rows are parsed into DTOs without extra fields", () => {
  const member = dto.toProjectMember(memberRow);
  assert.equal(member.profileId, memberRow.profile_id);
  assert.equal(member.isActive, false);
  assert.equal(member.addedAt, memberRow.created_at);
  assert.equal("password_hash" in member, false);
  assert.throws(() => dto.toProjectMember({ ...memberRow, role: "ADMIN" }), ProjectError);
  assert.throws(() => dto.toProjectMember({ ...memberRow, is_active: "yes" }), ProjectError);
  assert.deepEqual(dto.toDeveloperOption({ id: PM, full_name: "Dev", email: null, role: "DEVELOPER" }), { id: PM, fullName: "Dev", email: null });
});

test("team UI calls only server actions (no Supabase client or secret key in the browser)", () => {
  const source = readFileSync(new URL("../src/features/projects/components/project-team.tsx", import.meta.url), "utf8");
  assert.match(source, /^"use client";/);
  assert.doesNotMatch(source, /@supabase|createClient|SECRET_KEY|service_role/);
});

test("team migration keeps memberships write-protected and unique", () => {
  const team = readFileSync(new URL("../supabase/migrations/20261126100000_project_team_members.sql", import.meta.url), "utf8");
  assert.match(team, /unique \(project_id, profile_id\)/);
  assert.doesNotMatch(team, /grant[^;]*(insert|delete|update)[^;]*on table public\.project_members to (authenticated|service_role)/i);
});
