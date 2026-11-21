# Employee Management — Implementation Progress

Branch: `feature/employee-management` · Hosted project: `Cyclo` (`jbcvznfxycngysxwtbsz`)

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Inspect architecture, migrations, live schema; identify DB changes | **Done** (2026-11-20) |
| 2 | Secure read RPCs, DTOs, queries, column-grant narrowing | **Done locally** (2026-11-20); hosted apply pending approval |
| 3 | Employee directory UI (`/employees`, `/employees/[id]`) | **Done locally** (2026-11-21) |
| 4 | Admin mutations + audit log | Pending |
| 5 | Invitations, invite callback, onboarding + guard | Pending |
| 6 | Self-profile + avatar storage | Pending |
| 7 | Full verification + final report | Pending |

---

## Phase 1 — Inspection report

### 1. Repository and migration tracking

- Both migrations are tracked in Git and the working tree is clean:
  - `20261119120000_create_employee_profiles.sql` (commit `79f4a78`)
  - `20261120095347_protect_last_active_super_admin.sql` (commit `e07ed81`)
- **No migration was recreated or re-applied.** Nothing needed to be added to Git.

### 2. Live database vs repository (read-only checks only)

| Check | Result |
| --- | --- |
| `public.profiles` columns | Match the migration exactly (12 columns) |
| All 7 `private.*` function bodies | Byte-identical to the migration files (live copies use CRLF line endings, so they were applied from the SQL editor on Windows) |
| Function owners / `search_path` / ACLs | Match: owner `postgres`, `search_path=''`, only `current_app_role()` executable by `authenticated` |
| Triggers | `on_auth_user_created`, `on_auth_user_email_updated`, `profiles_set_updated_at`, `profiles_protect_last_active_super_admin` (ALWAYS), `profiles_prevent_truncate` (ALWAYS) |
| RLS policies | Own-row SELECT, active-Super-Admin SELECT all, own-row UPDATE when active |
| Grants | `authenticated`: table SELECT (all 12 columns), UPDATE (`full_name`, `avatar_url`) only |
| `private.super_admin_guard` | `active_count = 1`, consistent with data |
| Accounts | 1 auth user / 1 profile: active `SUPER_ADMIN`, `full_name` NULL, `employee_code` NULL, **`onboarded_at` NULL** |
| Storage buckets | **None** |
| `supabase_migrations.schema_migrations` | **Empty** — neither migration is recorded in the hosted CLI history |

### 3. Findings that affect later phases

1. **Hosted migration history is empty.** Both migrations were applied manually. As instructed, no reconciliation was done. Consequence: `supabase db push` would try to re-run both files and fail (`type app_role already exists`). New migrations must be applied the same way (SQL editor or MCP `apply_migration`), or the history repaired first with `supabase migration repair --status applied 20261119120000 20261120095347`. **Decision needed before the first new migration is applied.**
2. **Onboarding gate would lock out the only Super Admin.** Their `onboarded_at` is NULL. The onboarding migration must include an explicit backfill. Proposed rule (needs approval): set `onboarded_at = now()` for every profile that exists when the migration runs, has a confirmed Auth email, has signed in at least once, and has no invitation record. Today that matches exactly the one Super Admin.
3. **Raw table SELECT exposes administrative columns.** `authenticated` can read `invited_by`, `onboarded_at`, `is_git_organizer`, `created_at`, `updated_at` on any row RLS allows. Phase 2 replaces the table-level grant with column grants. The existing auth projection (`id, full_name, email, role, is_active`) is kept readable, so `getAccess()` keeps working.
4. **SECURITY DEFINER owned by a non-superuser is subject to RLS.** If read and mutation RPCs are owned by a dedicated `NOLOGIN` role, as the spec asks, that role does not have `BYPASSRLS`. It needs explicit `TO <role>` policies and column grants on `profiles`. The design below accounts for this. The last-admin trigger stays owned by `postgres` and is unchanged.
5. **`public.rls_auto_enable()`** is a SECURITY DEFINER function that Supabase created for the `ensure_rls` event trigger. The advisor flags it as executable by `anon` and `authenticated`. It is not ours and is low risk, because an event-trigger function cannot be invoked through RPC. Proposed fix: revoke EXECUTE from `anon` and `authenticated` in the Phase 2 migration (needs approval).
6. **Leaked-password protection is disabled** in hosted Auth (advisor WARN). This is a hosted config change, so it is only recommended here.
7. **Invitations need a server-only secret key.** `.env.local` has no service-role/secret key. Phase 5 will read `SUPABASE_SECRET_KEY` (server-only, never `NEXT_PUBLIC_`) through an `import "server-only"` admin client. You must add the key.
8. **Invite redirect URL.** `config.toml` `site_url` and redirects are localhost-only (local stack). The hosted Auth Site URL and redirect allow-list must include `<app-origin>/auth/confirm`. The invite email template must use the token-hash link (`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite`). Both are hosted config changes that need approval.
9. **Password policy.** Local config has `minimum_password_length = 6`. Onboarding will enforce a stronger application-side minimum (12 characters, at most 72 bytes because of bcrypt). Raising the hosted Auth minimum to match is recommended.
10. **No local test database is available yet.** Docker Desktop is installed but its daemon is not running, and the Supabase CLI is not installed (`npx supabase@latest` can be used). RLS, RPC and concurrency tests need `supabase start` locally. The live database will not be used as a test substitute.
11. `requireActiveProfile(roles)` throws a plain `Error` for a forbidden role, which renders the generic error boundary. For new pages, role mismatches will call `notFound()`/redirect at the page level, using a small additive helper. The existing function's behaviour is unchanged.

### 4. Baseline verification (before any change)

| Check | Result |
| --- | --- |
| `eslint . --max-warnings=0` | Pass |
| `tsc --noEmit` | Pass |
| `node --experimental-strip-types --test tests/*.test.mjs` | 12/12 pass |
| `next build --webpack` | Pass (routes `/`, `/login`, `/dashboard`) |

### 5. Planned database changes (new files only; none written or applied yet)

| Migration | Contents |
| --- | --- |
| `…_employee_directory_read_rpcs.sql` | `NOLOGIN` owner role `cyclo_employee_api` with column-limited SELECT and a `TO cyclo_employee_api` policy on profiles. Private implementations plus `public` wrappers: `list_employees(search, role, is_active, page, page_size)`, `get_employee(id)` (directory DTO), `admin_get_employee(id)` (SA only), `get_my_profile()`. Each resolves `auth.uid()`, checks active role inside the database, returns fixed columns as `TABLE(...)`, validates and bounds input, and uses a stable sort (`full_name NULLS LAST, email, id`). Narrows `authenticated` SELECT to column grants. Revokes RPC EXECUTE from `public`/`anon`. |
| `…_employee_admin_mutations_audit.sql` | `private.employee_audit_log` (append-only; no grants to API roles; DB timestamps). Individual SA-only RPCs: `admin_update_employee_details`, `admin_set_employee_code`, `admin_set_employee_role`, `admin_set_employee_active`, `admin_set_git_organizer`. Each locks actor and target rows in id order, re-checks the actor in the same transaction, blocks self-demotion and self-deactivation, writes the audit row in the same transaction, and maps the last-admin `23514` error to a stable error code. |
| `…_employee_invitations_onboarding.sql` | `private.employee_invitations` (state model: `pending → accepted → completed`, plus `revoked`, `expired`, `failed`; no tokens stored). RPCs to record, resend, cancel and list invitations (SA only), and to complete onboarding (self; sets `onboarded_at`, never touches `is_active`). Approved backfill of `onboarded_at` for pre-existing accounts. |
| `…_avatar_storage.sql` | `avatars` bucket (size and MIME limits) with storage policies restricting writes to `<auth.uid()>/…`. Hosted storage change, needs approval. |

### 6. Security considerations

- No hosted configuration, data, or schema was changed in Phase 1. Only `SELECT` statements and advisor reads were run.
- No secrets were printed. `.env.local` was checked only for the project URL host and whether a service key is present (it is not).

### 7. Remaining work

Phases 2–7. Blocking inputs: decisions 1, 2 and 10 above.

---

## Phase 2 — Secure read architecture

### Files

| File | Change |
| --- | --- |
| `supabase/migrations/20261120130000_employee_directory_read_rpcs.sql` | **New** migration (applied to the local stack only) |
| `supabase/tests/database/employee_directory.test.sql` | **New** pgTAP suite (53 assertions, rolled back) |
| `tests/integration/employee-rpc.local.mjs` | **New** HTTP tests against local Auth and PostgREST (refuses non-loopback URLs) |
| `tests/employees.test.mjs` | **New** unit tests (validation, DTOs, error mapping, server query layer) |
| `src/features/employees/{types,validation,dto,errors}.ts` | **New** DTOs, input validation, strict row parsers, safe error mapping |
| `src/features/employees/queries.server.ts` | **New** `server-only` queries: `listEmployees`, `getEmployee`, `adminGetEmployee`, `getMyProfile` |
| `src/types/database.ts` | **New** generated from the local schema |
| `src/lib/supabase/server.ts` | Typed with `Database` (one-line, backward compatible) |
| `scripts/gen-db-types.mjs`, `package.json`, `README.md` | `test`, `test:db`, `test:integration` and `db:types` scripts |

### RPCs and authorization

| RPC (public, `SECURITY INVOKER`) | Allowed callers | Returns |
| --- | --- | --- |
| `list_employees(p_search, p_role, p_is_active, p_page, p_page_size)` | active SA, PM | `id, full_name, avatar_url, email, employee_code, role, is_active, total_count` |
| `get_employee(p_employee_id)` | active SA, PM | directory columns |
| `admin_get_employee(p_employee_id)` | active SA | directory columns, plus `is_git_organizer, invited_by, invited_by_name, onboarded_at, created_at, updated_at` |
| `get_my_profile()` | any active employee (own row) | directory columns, plus `is_git_organizer, onboarded_at` |

- Each wrapper calls a `private.*` SECURITY DEFINER implementation owned by **`cyclo_employee_api`**: `NOLOGIN`, no `BYPASSRLS`, `SELECT`-only on `profiles` through a dedicated `TO cyclo_employee_api` policy. No login role can `SET` or `INHERIT` it.
- Identity comes from `auth.uid()` through `private.request_user_id()`, a 1-line `postgres`-owned bridge that only the owner role may execute, because `postgres` cannot grant `USAGE` on `auth`. No RPC accepts an actor id or role.
- `private.require_employee_actor()` re-reads the caller's profile on every call and rejects missing, inactive or wrong-role callers with `42501`.
- Input checks: page 1–100000, page size 1–100, search ≤ 100 characters after trimming. LIKE wildcards are escaped. Enum and uuid types are validated by Postgres. The sort is fixed and stable: `lower(full_name) NULLS LAST, lower(email), id`. No dynamic SQL.
- Error contract: `42501 unauthenticated|forbidden`, `22023 invalid_*`. The app maps these to safe messages and logs only the SQLSTATE.

### Database changes (this migration)

- Role `cyclo_employee_api` and policy `"Employee API role reads profiles for authorized RPCs"`.
- `authenticated` table-level SELECT on `profiles` is **replaced** by column SELECT on `id, email, full_name, avatar_url, employee_code, role, is_active`. `invited_by`, `onboarded_at`, `is_git_organizer`, `created_at` and `updated_at` are no longer directly readable. UPDATE (`full_name`, `avatar_url`), RLS policies, triggers and the last-admin protection are unchanged. The existing `getAccess()` projection keeps working (verified over HTTP).
- **Residual:** PostgreSQL gives the role's creator (`postgres`) an automatic `ADMIN OPTION` membership, without `SET` or `INHERIT`, which `postgres` cannot remove. `postgres` cannot act as the role through it. Later migrations that replace these functions repeat the temporary grant/revoke pattern documented in section 8.

### Tests

| Suite | Result |
| --- | --- |
| `pnpm test:db` (pgTAP via `supabase test db`) | 53/53 pass |
| `pnpm test:integration` (local HTTP) | 7/7 pass; throwaway users deleted afterwards (0 users / 0 profiles remain) |
| `pnpm test` | 28/28 pass (12 existing + 16 new) |
| `eslint`, `tsc --noEmit`, `next build --webpack` | Pass |

Covered: SA and PM see all employees, including inactive ones. A PM cannot get admin detail or admin columns, whether through RPCs or the table API. A developer cannot list or read others but can read their own profile. Inactive and anonymous callers are denied. Direct calls to the private function enforce the same rules, and private functions are not reachable over HTTP. Auth metadata cannot elevate a role. Search is literal, pagination and filters work, and invalid input is rejected.

### Security considerations

- Directory DTO parsers copy only whitelisted fields, so a column added to an RPC by mistake cannot reach a Project Manager's page.
- Generated types mark RPC result columns non-null, which is a generator limitation; the runtime parsers enforce the real nullability.
- Hosted database untouched. Applying this migration to hosted requires your approval **and** the migration-history decision from Phase 1 (finding 1).

### Remaining

Phase 3 (directory UI) builds on `queries.server.ts`. Still open from Phase 1: migration-history approach (finding 1) and the onboarding backfill rule (finding 2, needed by Phase 5).

---

## Phase 3 — Employee directory UI

### Routes

| Route | Access | Data source |
| --- | --- | --- |
| `/employees` | active SA, PM | `list_employees` (server-side search, filters, pagination) |
| `/employees/[id]` | active SA: directory + administration cards; PM: directory card only | SA → `admin_get_employee`; PM → `get_employee` (separate DTOs) |
| Developers / other roles | Real HTTP **404**, styled not-found page, generic title, no data | — |

### Files

| File | Change |
| --- | --- |
| `src/app/(dashboard)/employees/{layout,page,loading,error}.tsx` | **New** directory route. The layout's role gate runs above the loading boundary, so the 404 status is real. |
| `src/app/(dashboard)/employees/[id]/{layout,page,loading}.tsx` | **New** detail route. The layout rejects malformed ids with a 404. |
| `src/app/(dashboard)/not-found.tsx` | **New** styled 404 inside the signed-in shell |
| `src/app/(dashboard)/layout.tsx` | Renders the new app header |
| `src/app/(dashboard)/dashboard/page.tsx` | One class change: `min-h-svh` → `flex-1`, to fit below the header |
| `src/components/layout/{app-header,nav-link}.tsx` | **New** header with role-aware navigation and log out |
| `src/features/employees/components/*` | **New** `EmployeeTable` (table on md+, cards on mobile), `EmployeeFilters` (GET form, no client JS), `Pagination`, `EmployeeAvatar`, `RoleBadge`/`EmployeeStatusBadge`, `EmployeeDetails` cards, `StatePanel` |
| `src/features/employees/{format,page-errors.server}.ts` | **New** display helpers. `loadForPage` maps forbidden/not-found to a 404, an expired session to `/login`, and other failures to an inline error. |
| `src/features/employees/validation.ts` | Adds `canViewDirectory`, `hasActiveFilters`, `directoryHref` |
| `src/features/auth/server.ts` | **Changed:** `getRequestAccess` uses React `cache()` (details below) |
| `tests/employees-ui.test.mjs`, `tests/helpers/load-ts-module.mjs` | **New** server-render tests for components, helpers and page error handling |
| `supabase/tests/database/employee_directory.test.sql` | Fixtures moved to `@pgtap.test` / `PGT-*` and counts scoped, so the suite passes with seeded local data |
| `scripts/seed-local-employees.mjs`, `scripts/dev-local.mjs`, `package.json`, `README.md` | Local-only seeding and run helpers (both refuse non-loopback URLs) |

### Auth change (backward compatible)

`requireActiveProfile()` previously ran a new Supabase Auth `getUser()` and profile query on every call. One directory request called it four or more times: the dashboard layout, the employees layout, the page and each query. It now reads `getRequestAccess()`, which React `cache()` memoizes **per server request only**. Behaviour is identical, and deactivation still takes effect on the next request. `getAccess()`, the proxy and login are unchanged.

### UX

- Search, role and status filters live in the URL, so they are shareable and work with the back button. Applying a filter resets to page 1, and each parameter is validated (`parseDirectoryQuery`).
- Server-side pagination uses page sizes 10, 20 or 50 (default 20). An out-of-range page shows "This page is out of range" with a link back.
- States: loading skeletons, empty ("No employees yet"), no matches (with Clear), inline error with retry, a generic `error.tsx` that never shows raw messages, and a styled 404.
- Accessibility: labelled controls, `role="search"`, table caption and `scope` headers, `aria-current` on the active nav item and current page, `aria-label` on icon-only buttons and "View" links, visible focus rings, and decorative avatars with `alt=""`.
- Responsive: a table at tablet/desktop widths and cards on mobile. Verified at 375px with no horizontal scroll.
- Privacy: employee names never appear in tab titles. Avatars render only for `https` URLs, as a plain `<img>` with `referrerPolicy="no-referrer"`.

### Verification

| Check | Result |
| --- | --- |
| `pnpm test` | 40/40 (adds 12 UI/helper tests) |
| `pnpm test:db` | 53/53 (with 28 seeded local employees present) |
| `pnpm test:integration` | 7/7 |
| `eslint`, `tsc --noEmit`, `next build --webpack` | Pass |
| Browser (local stack, seeded SA/PM/Dev) | SA sees the list and admin detail. Search (including literal `%`), filters, pagination, out-of-range and no-match states all work. Invalid and unknown ids return 404. PM sees directory fields only; the page HTML and RSC payload contain no admin field names or values. The developer has no nav link and gets a 404 on all employee URLs, with no data. The mobile layout is correct. |

### Notes and limitations

- `.claude/launch.json` (local preview config) and `.env.seed-local` are local files and are not part of the commit.
- The seeded local Super Admin (`admin@cyclo.test`) cannot be deleted while it is the only active local Super Admin. That is the last-admin protection working as designed.
- An *unknown but well-formed* employee id for an authorized viewer still returns 404 content with a streamed 200 status, because the lookup happens below the loading boundary. No data is exposed.
- No edit actions yet; the "View" action is the only row action until Phase 4.
