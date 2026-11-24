# Employee Management — Implementation Progress

Branch: `feature/employee-onboarding` · Hosted project: `Cyclo` (`jbcvznfxycngysxwtbsz`)

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Inspect architecture, migrations, live schema; identify DB changes | **Done** (2026-11-20) |
| 2 | Secure read RPCs, DTOs, queries, column-grant narrowing | **Done locally** (2026-11-20); hosted apply pending approval |
| 3 | Employee directory UI (`/employees`, `/employees/[id]`) | **Done locally** (2026-11-21) |
| 4 | Admin mutations + audit log | **Done locally** (2026-11-21); hosted deployment remains unapproved |
| 5 | Invitations, invite callback, onboarding + guard | **Done locally** (2026-11-21); hosted deployment unapproved |
| 6 | Self-profile + avatar selection and storage | **Done locally** (2026-11-24); hosted deployment unapproved |
| 7 | Full verification + final report | **Review done locally** (2026-11-24); H1 and M1 fixed locally; see `PHASE7_REVIEW.md`. Open: M2–M4, L1–L6; hosted deployment unapproved |

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


---

## Phase 4 — Employee management actions

Implemented locally on 2026-11-21, on the existing feature/employee-management-actions branch at e88777a. Local history was inspected; remote GitHub DNS was unavailable during inspection. The user approved proceeding from this branch. No reset, commit, push, or merge was performed.

### Database

- New migration: supabase/migrations/20261121042440_employee_admin_mutations_audit.sql. Created with the pinned Supabase CLI; only this migration was applied to the local 127.0.0.1:54322 stack. No existing migration was edited.
- New RPCs (public SECURITY INVOKER wrappers with private SECURITY DEFINER implementations): admin_update_employee_details, admin_set_employee_code, admin_set_employee_role, admin_set_employee_active, admin_set_git_organizer.
- Private helper lock_employee_admin_target derives identity through the existing auth.uid() bridge, locks actor/target in UUID order, and re-reads active Super Admin authorization after acquiring the locks. Its EXECUTE is not granted to authenticated users.
- Reuses cyclo_employee_api (NOLOGIN, no BYPASSRLS), existing SELECT policy, empty search_path, schema-qualified objects, explicit return columns and the existing ownership-transfer pattern. Adds only column UPDATE grants for the six Phase 4 fields and a dedicated owner-role UPDATE policy. No new direct privileges for authenticated users.
- Self-demotion and self-deactivation fail in both server mutations and database RPCs. A second active admin can manage the first. The existing last-admin trigger and counter are unchanged. Concurrent cross-admin demotion allows one winner; the other caller is then forbidden.
- Full names are trimmed and limited to 200 characters. Avatar URLs require HTTPS and are limited to 2048 characters. Codes are trimmed, blank becomes NULL, length is limited to 32, existing accepted characters and case-sensitive uniqueness are preserved. A database enum validates roles; NULL booleans/roles are rejected.
- Each mutation returns the existing safe admin detail projection. Email, invited_by and onboarded_at are never updated. Reactivation changes only is_active.

### Audit design

private.employee_audit_log contains UUID id, actor_id, target_employee_id, constrained action, old_values/new_values JSON objects and a database timestamp. Identity always comes from the authenticated session. The API owner can INSERT only the five payload columns, with an actor-identity RLS check; ordinary API roles cannot read, insert, update, delete or truncate the audit table. The API owner cannot update/delete audit records either.

Audits and mutations share one transaction; an audit failure rolls back the profile change. No-op requests skip both UPDATE and audit insertion. Payloads contain only operation-relevant fields. Profile audits store full_name and avatar_url_sha256 rather than raw avatar URLs, preventing signed URL tokens or URL credentials from being copied into history. Other actions store only employee_code, role, is_active or is_git_organizer. UUIDs deliberately have no cascading profile foreign keys, preserving history after disposable test accounts are removed. No audit history UI or directory exposure was added.

### Application and UI files

| File | Change |
| --- | --- |
| src/features/employees/mutation-validation.ts | Runtime validation and normalization |
| src/features/employees/mutations.server.ts | Five typed server-only mutations using the caller's SSR Supabase session; role checks, self restrictions and strict DTO parsing |
| src/features/employees/actions.ts | Five Server Actions; field allowlists, safe feedback and list/detail route revalidation |
| src/features/employees/errors.ts | Duplicate code, self-management, last-admin and missing-target errors; no raw PostgreSQL messages shown |
| src/features/employees/components/employee-management.tsx | Responsive admin forms, native confirmation dialogs, pending/feedback states and duplicate-submit guard |
| src/app/(dashboard)/employees/[id]/page.tsx | Mounts management controls only in the Super Admin DTO branch |
| src/types/database.ts | Regenerated from local Supabase |
| supabase/tests/database/employee_mutations.test.sql | 75 transactional pgTAP assertions |
| tests/employee-mutations.test.mjs | 22 additional application tests |
| tests/integration/employee-mutations.local.mjs | Six additional loopback-only Auth/PostgREST tests |

Project Managers continue receiving only directory fields. Developers still receive a 404 for employee administration pages. Directory layout, search, role/status filters and pagination were preserved; no list RPC or DTO was widened for Git Organizer.

### Verification

| Check | Result |
| --- | --- |
| pnpm lint | Pass |
| pnpm typecheck | Pass |
| pnpm test | 65/65 pass, zero skipped |
| pnpm test:db | 128/128 pass across two files: 53 existing + 75 Phase 4 |
| pnpm test:integration | 13/13 pass: seven existing + six Phase 4 |
| pnpm build | Pass, with local Supabase environment overrides |
| Local db lint | No schema errors |
| Local security advisors (warning/error level) | No issues |
| Final migration transactional replay | All statements succeeded; replay rolled back without data loss |
| git diff --check | Pass |

Coverage includes all five mutation endpoints for anonymous/developer/PM/inactive-admin callers, spoofed actor/extra-column attempts, direct-table RLS, invalid input, duplicate codes, self restrictions, last-admin trigger preservation, successful/no-op/failed audits, forced audit failure rollback, constrained audit actions, audit access denial, avatar audit redaction, unchanged read behavior, second-admin management and concurrent cross-admin demotion. Application coverage includes mutation/action success and errors, revalidation, DTO allowlists, actual page visibility by role, confirmation cancellation, pending feedback and duplicate submission prevention. Existing tests were not weakened or modified.

Browser checks against a production local build verified admin controls, code persistence and success feedback, duplicate-code feedback, role/deactivation confirmations with Cancel initially focused, deactivation/reactivation and self restrictions. A narrow mobile viewport had equal document/client widths, with no horizontal overflow. Two disposable browser users were removed after testing; the original 28 local profiles remain and the admin counter is consistent. Audit records from local integration/browser fixtures intentionally remain.

### Scope and remaining decisions

- Hosted Supabase was never accessed or modified. No hosted configuration, onboarding, invitation or profile/storage work was performed.
- Docker access required execution outside the sandbox; it was resolved for the local stack. No database work remains blocked.
- Hosted migration history/deployment strategy and the future onboarding rule remain unresolved as previously documented. No Phase 5 work was started.
- All Phase 4 work remains uncommitted. Temporary verification files and the local preview server are removed/stopped before handoff. Existing Node module-type warnings remain informational and unchanged.


---

## Phase 4 — Security review fixes (2026-11-21)

Both Low findings were addressed on feature/employee-management-actions. The pre-existing Phase 1–4 migrations were not changed. A single forward migration was added: supabase/migrations/20261121095459_employee_mutation_security_hardening.sql. It was applied successfully to the local 127.0.0.1:54322 stack through the pinned CLI migration workflow. A subsequent dry-run reports no pending migrations.

### Authorization before locking

The old helper acquired actor/target FOR UPDATE locks before testing the caller's role. The replacement private.lock_employee_admin_target resolves the existing auth.uid() bridge and rejects inactive/non-Super-Admin callers before any employee row locks. It then locks actor and target in the existing deterministic UUID order and repeats the authorization check after the wait. That second check remains authoritative. Self-management checks and the existing last-admin triggers/counter are unchanged.

Two behavioral integration regressions exercise real competing PostgreSQL sessions. One holds actor and target rows locked and verifies Developers, PMs and inactive admins return 42501 forbidden rather than lock timeout. The other observes an authorized caller waiting on a lower-UUID target lock, deactivates the caller before releasing that lock, and verifies the post-lock check rejects the mutation without changing the target. The existing concurrent cross-admin demotion test still passes.

### Avatar policy

The former database prefix/shape regex admitted malformed authorities, and TypeScript relied on WHATWG URL repair. Both layers now use a documented, deliberately consistent syntax policy; see AVATAR_URL_POLICY.md. HTTPS, a valid nonempty DNS/IP host, optional decimal port 1–65535, and the 2,048-code-point limit are independently enforced. Credentials, whitespace/control characters, malformed authorities and backslashes are rejected. NULL and genuinely empty input still clear the avatar. DNS/punycode, canonical IPv4, bracketed IPv6, ordinary paths, Unicode paths, query strings and fragments remain supported.

The policy uses a new private immutable SECURITY INVOKER validator owned by cyclo_employee_api, without EXECUTE grants to public/anon/authenticated/service_role. The two replacement privileged functions retain that owner, SECURITY DEFINER and empty search_path. Existing wrappers, RPC signatures, DTOs, RLS policies, column grants and audit behavior are unchanged. Temporary schema CREATE and SET-role privileges are revoked in the migration transaction.

The one existing application-test expectation changed intentionally: a whitespace-only avatar no longer clears the avatar, because the approved policy requires rejecting URL whitespace. Empty-string and NULL clearing are still tested. No test was weakened.

### Files for this follow-up

| File | Change |
| --- | --- |
| supabase/migrations/20261121095459_employee_mutation_security_hardening.sql | New validator and two narrowly scoped function replacements |
| src/features/employees/avatar-url-policy.ts | Matching TypeScript URL policy |
| src/features/employees/mutation-validation.ts | Uses policy without trimming URL whitespace |
| docs/employee-management/AVATAR_URL_POLICY.md | Accepted subset and normalization policy |
| tests/fixtures/avatar-url-cases.json | 59 shared application/direct-RPC cases |
| tests/employee-security-hardening.test.mjs | 59 new application tests |
| supabase/tests/database/employee_security_hardening.test.sql | 31 new pgTAP assertions |
| tests/helpers/local-postgres.mjs | Local-only competing-session test orchestration |
| tests/integration/employee-mutations.local.mjs | 59 shared RPC cases, two lock/auth races, owner-only cleanup of disposable audit fixtures |
| tests/employee-mutations.test.mjs | Updates whitespace-only URL expectation |
| docs/employee-management/PROGRESS.md | This report |

### Verification

| Check | Result |
| --- | --- |
| pnpm lint | Pass |
| pnpm typecheck | Pass |
| pnpm test | 130/130 pass, zero skipped (includes six theme tests present in the current repository) |
| pnpm test:db | 159/159 pass, zero failures (128 existing + 31 new) |
| pnpm test:integration | 74/74 pass, zero skipped (13 existing + 61 new) |
| pnpm build | Pass with explicit local Supabase configuration |
| Local database SQL lint | No schema errors |
| Local security advisors at warning/error level | No issues |
| Git diff whitespace check | Pass |

Both findings are closed by source review and behavioral regressions. The original 28 profiles remain with the same sorted-ID fingerprint (f4b8b85720012a438cf60b99fca4c9b7), and all 32 pre-existing audit records remain. New integration users/profiles and their disposable audit rows are removed after the suite using trusted local fixture cleanup; ordinary users still have no audit DELETE access. Existing demo avatar URLs were all NULL, so no existing nonempty URL was rejected or rewritten. The last-admin counter remains consistent.

Docker was initially unavailable; the installed Docker Desktop engine was brought online and all database/integration checks above were actually executed. No reset or hosted connection was used. Existing repository HEAD changed externally to 0e0bf07 during the task; those changes, including theme work, were preserved. This follow-up remains uncommitted. No commit, push, merge, hosted change or Phase 5 work was performed by this task.


---

## Phase 5 — Invitations and onboarding (local only)

Implemented on the current feature/employee-onboarding branch. Existing migrations and existing profile data were preserved. The current Auth/profile access projection remains unchanged: existing active employees, including an administrator with NULL full_name/onboarded_at, are not forced into onboarding. No hosted profile backfill or email-specific bypass was introduced.

### Migrations and RPCs

- 20261121101643_employee_invitations_onboarding.sql: private invitation authority, uniqueness, immutable email/name/assigned-role/inviter, lifecycle/delivery timestamps, existing audit extension, trusted Auth identity bridge, trigger integration and scoped RPCs.
- 20261121103439_invitation_acceptance_expiry_guard.sql: wall-clock expiry and fresh confirmed-email binding after invitation lock acquisition.
- 20261121103735_invitation_resend_recovery.sql: preserves ACCEPTED/ONBOARDING state on resend to recover a lost browser session without acceptance replay.

Public SECURITY INVOKER wrappers backed by private SECURITY DEFINER implementations owned by cyclo_employee_api:

| RPC | Authorization / purpose |
| --- | --- |
| admin_create_employee_invitation | Active Super Admin; normalized input, existing-account and duplicate-pending rejection, reservation plus audit |
| admin_list_employee_invitations | Active Super Admin; up to 200 recent fixed DTOs |
| admin_resend_employee_invitation | Active Super Admin; renew expiry, preserve recovery state, audit |
| admin_revoke_employee_invitation | Active Super Admin; terminal revoke and audit |
| admin_record_invitation_delivery | Active Super Admin; safe delivery outcome, no raw provider errors |
| get_my_employee_invitation | Confirmed Auth user; own normalized email and linked UUID only |
| accept_employee_invitation | Confirmed invitee; locked PENDING → ACCEPTED, rejects expired/revoked/replay |
| start_employee_onboarding | Own ACCEPTED invitation and actual Auth password presence |
| complete_employee_onboarding | Own ONBOARDING invitation; atomically complete record, set name/onboarded_at, preserve role and activate |

Every privileged database function keeps an empty search_path and explicit EXECUTE grants. The private schema is not exposed. No direct invitation table privileges were granted to authenticated/anon/service_role. Actor identity comes from the trusted auth.uid() bridge; Auth confirmation/password presence are read only through a private postgres-owned Auth bridge. No credentials, hashes or tokens are exposed to callers or audits.

### Trigger and access security

The Auth user insert trigger links matching pending invitations by normalized email, copies the database-authoritative role/name/inviter and creates an inactive requires_onboarding profile. Editable Auth metadata is ignored. Unmatched Auth invitations are rejected. Non-invitation provisioning retains the previous default behavior.

A new profile guard prevents activation, invitation-role replacement, inviter changes and Git Organizer escalation before successful onboarding. Existing active profiles have requires_onboarding=false, with no other fields changed. Only the new scoped completion RPC clears that flag and sets onboarding time. The existing last-active-Super-Admin triggers/counter are unchanged.

The function-owner role gains only the extra onboarding timestamp/flag UPDATE columns required for atomic completion. One Phase 4 assertion expecting no owner UPDATE on onboarded_at was replaced with an explicit owner-grant assertion plus ordinary-authenticated denial. Two direct RPC assertions now verify Phase 4 activation/role operations cannot bypass invitation authority. No authenticated column grants were broadened; the test expectation changed to reflect the new scoped capability rather than hiding a failure.

### Application workflow

Employees now links active Super Admins to /employees/invitations, with invite form, status/expiry, delivery feedback, resend and revoke. PM/Developer requests fail before querying invitation records. The existing directory and restricted DTOs remain intact.

The server-only Auth Admin client checks authorization before every Admin send, accepts the SDK's modern secret key or local legacy service-role JWT and rejects non-loopback Supabase targets pending deployment approval. Initial/unverified emails use inviteUserByEmail; verified incomplete accounts use Auth-generated signInWithOtp resume emails, because Auth will not re-invite verified accounts. There is no manual email system or Nodemailer.

/auth/confirm validates invite/email token hashes with Supabase, writes the SSR session and accepts or resumes only the caller's valid invitation. It ignores arbitrary next URLs and signs out when database acceptance fails. /onboarding sets the password via Auth; /onboarding/complete collects only full name. Login can resume a valid accepted/in-progress invitation; normal routes remain denied until completion. Replayed tokens and state transitions fail. Concurrent completion permits one winner.

Email delivery cannot be in the database transaction. Failed delivery leaves a recoverable reservation with safe feedback. The database still rejects a revoked/expired invitation even if an Auth email was already sent or verified. Expiration is effective from expires_at in DTOs and mutation checks without requiring a scheduled job.

### Files and environment

Implementation files: src/features/invitations/{types,validation,errors,operations.server,actions,onboarding.server,onboarding-actions,forms}; src/lib/supabase/admin.server.ts; callback/onboarding/invitation routes; existing auth actions/proxy, login messaging and Employees link; generated src/types/database.ts. Local config/template changes are in supabase/config.toml and supabase/templates/{invite,onboarding-resume}.html. .env.example contains placeholders only; scripts/dev-local.mjs maps local server credentials without exposing them publicly.

Exact variables: existing NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY; new server-only SUPABASE_SECRET_KEY and CYCLO_APP_URL. The local runner maps local status SECRET_KEY/SERVICE_ROLE_KEY and the selected local port automatically. No Gmail/SMTP application variables or credentials are needed. The deployment guard remains local-only until explicit hosted deployment approval.

See INVITATIONS.md for local use, test-server setup, complete lifecycle/security notes and future Gmail SMTP preparation. Future SMTP belongs in Supabase Dashboard → Authentication → SMTP Settings: smtp.gmail.com, port 465, SSL/TLS, authorized full Gmail username, Google App Password, matching sender. Google 2-Step Verification and account eligibility are documented. No hosted Auth/SMTP/template/redirect setting was changed.

### Verification

| Check | Final result |
| --- | --- |
| pnpm lint | Pass, zero ESLint warnings |
| pnpm typecheck | Pass |
| pnpm test | 149/149 pass, zero skipped |
| pnpm test:db | 187/187 pass in four files |
| pnpm test:integration | 82/82 pass, zero skipped |
| pnpm build | Pass with explicit local Supabase configuration |
| Local security advisors | No issues |
| Local SQL lint | No errors; two unused-variable warnings (get_my_employee_invitation.v_unused and lock_my_invitation.v_password) |
| Git diff whitespace check | Pass |

New focused coverage: 18 invitation/action/callback/UI/legacy-auth unit tests, one proxy allowlist test, 27 invitation pgTAP assertions and eight real Auth/Mailpit/app integration tests. The integration suite includes posting the rendered invitation Server Action, captured local email links, callback cookie/session establishment, selected Super Admin role, pre-onboarding route denial, replay rejection, expired/revoked denial, state-preserving resend recovery, concurrent completion and expiry during a row-lock wait.

The original 28 local profiles remain with sorted-ID fingerprint f4b8b85720012a438cf60b99fca4c9b7. The original 32 audit records remain; invitation fixtures, their Auth users/profiles, disposable audit rows and Mailpit messages were removed. The Super Admin counter is consistent. Docker/local Auth was restarted with data-preserving CLI stop/start to load local email templates; no db reset was run. An existing process on port 3000 was preserved, and the isolated verification server used port 3105.

### Remaining decisions and handoff

Hosted migration history/deployment approval remain unresolved. The new Admin client deliberately refuses hosted targets. Gmail production SMTP and Auth templates/redirect configuration are documented for later approval, not configured here. The two SQL lint warnings are nonfunctional unused-variable diagnostics; applied migrations were kept immutable. No Phase 6 avatar upload work was performed. No commit, push or merge was performed.

### Final uncommitted file inventory

- Modified: .env.example
- Modified: docs/employee-management/PROGRESS.md
- Modified: scripts/dev-local.mjs
- Modified: src/app/(auth)/login/page.tsx
- Modified: src/app/(dashboard)/employees/page.tsx
- Modified: src/features/auth/actions.ts
- Modified: src/lib/supabase/proxy.ts
- Modified: src/types/database.ts
- Modified: supabase/config.toml
- Modified: supabase/tests/database/employee_mutations.test.sql
- Modified: tests/helpers/load-ts-module.mjs
- Modified: tests/ssr-proxy.test.mjs
- New: docs/employee-management/INVITATIONS.md
- New: src/app/(dashboard)/employees/invitations/page.tsx
- New: src/app/auth/confirm/route.ts
- New: src/app/onboarding/complete/page.tsx
- New: src/app/onboarding/layout.tsx
- New: src/app/onboarding/page.tsx
- New: src/features/invitations/actions.ts
- New: src/features/invitations/errors.ts
- New: src/features/invitations/forms.tsx
- New: src/features/invitations/onboarding-actions.ts
- New: src/features/invitations/onboarding.server.ts
- New: src/features/invitations/operations.server.ts
- New: src/features/invitations/types.ts
- New: src/features/invitations/validation.ts
- New: src/lib/supabase/admin.server.ts
- New: supabase/migrations/20261121101643_employee_invitations_onboarding.sql
- New: supabase/migrations/20261121103439_invitation_acceptance_expiry_guard.sql
- New: supabase/migrations/20261121103735_invitation_resend_recovery.sql
- New: supabase/templates/invite.html
- New: supabase/templates/onboarding-resume.html
- New: supabase/tests/database/employee_invitations.test.sql
- New: tests/integration/invitations.local.mjs
- New: tests/invitations.test.mjs


---

## Phase 6 — Own profile and avatar selection (local only)

Implemented on 2026-11-24 on `feature/employee-onboarding`. Hosted Supabase was not accessed. Existing migrations were not edited. One forward migration was applied to the local stack with the pinned CLI (`supabase migration up`); no reset.

Also included before Phase 6 (approved separately): `/auth/confirm` now redirects with a host-relative `Location`, so a session created on `127.0.0.1` is not lost on a redirect to `localhost`; `next.config.ts` allows `127.0.0.1` as a dev origin.

### Avatar model

Explicit, validated selection state on `public.profiles`:

| Column | Meaning |
| --- | --- |
| `avatar_kind` | `default` (admin `avatar_url`, else initials) · `initials` · `image` · `emoji` · `icon`; default `default` |
| `avatar_symbol` | Allowlisted emoji or Lucide icon **identifier** (e.g. `fox`, `git-branch`) when kind is emoji/icon; NULL otherwise. Never markup, URLs or free text |
| `avatar_path` | Object name in the private `avatars` bucket, exactly `<profile id>/<uuid>.<jpg\|png\|webp>`; never a URL |

Display priority (resolved on the server): uploaded image → emoji/icon → administrator `avatar_url` (only while kind is `default`) → initials. Choosing `initials` is an explicit choice and also hides an admin URL. Switching to emoji/icon/initials keeps an uploaded photo so the employee can switch back; "Remove photo" deletes it.

CHECK constraints enforce the kind list, the symbol allowlists, the per-owner path shape and "image requires a path" for every writer. They call no functions, so Auth triggers and existing grants are unaffected. The 24 emoji and 24 icon identifiers are duplicated in `src/features/profile/avatar-catalog.ts`; a unit test fails if the two lists differ.

### Storage

- Bucket `avatars`: private, 2 MiB limit, `image/jpeg`, `image/png`, `image/webp` only (no SVG/GIF).
- `storage.objects` policies (authenticated, active employees only via `private.current_app_role()`):
  - INSERT only to `<own uid>/<uuid>.<ext>`.
  - SELECT own objects, or any avatar for active Super Admins / Project Managers (directory rule).
  - DELETE own objects only.
  - No UPDATE policy, so uploads can never overwrite.
- Images are served only through short-lived (1 hour) signed URLs created on the server with the viewer's own session. The app accepts a signed URL only if it points at this project's `/storage/v1/object/sign/avatars/` endpoint.

### RPCs

Public SECURITY INVOKER wrappers; private SECURITY DEFINER implementations owned by `cyclo_employee_api` (created with the temporary `SET ROLE` pattern from the Phase 4 hardening migration). No RPC accepts an employee or actor id.

| RPC | Authorization / behaviour |
| --- | --- |
| `get_employee_avatars(uuid[])` | Any active employee. SA/PM receive any requested ids (max 100); everyone else receives only their own row |
| `update_my_profile(text)` | Own full name; trimmed, 1–200 chars; audited `SELF_PROFILE_UPDATED` |
| `set_my_avatar(text, text)` | `default`/`initials`/`emoji`/`icon`, or `image` when a photo is already attached; audited `SELF_AVATAR_UPDATED` |
| `set_my_avatar_image(text)` | Attaches an object that exists in the bucket, in the caller's folder, **owned by the caller** (checked through `private.my_avatar_object_exists`, a postgres-owned bridge executable only by the RPC owner); returns the previous path |
| `remove_my_avatar_image()` | Detaches the photo (image → default); returns the previous path |

All writes lock the caller's row and re-check that the caller is still active after the lock. No-op changes skip both update and audit. Self audits must target the actor (constraint). The RPC owner gained UPDATE only on the three new columns. Role, active status, employee code, Git Organizer, email, invitation and onboarding fields are never written by Phase 6 code. Phase 4 admin `avatar_url` management and its RPC are unchanged.

### Application

| File | Purpose |
| --- | --- |
| `supabase/migrations/20261124100000_own_profile_avatars.sql` | Columns, constraints, bucket, storage policies, bridge, RPCs, audit actions |
| `src/features/profile/avatar-catalog.ts`, `avatar-icons.tsx` | Curated emoji/icon allowlists and static icon map |
| `src/features/profile/avatar.ts` | State parser (fails closed), display priority, signed-URL trust check, file-signature validation |
| `src/features/profile/avatars.server.ts` | Batch avatar reads and signed URLs; failures fall back to initials |
| `src/features/profile/mutations.server.ts`, `actions.ts`, `errors.ts` | Server Actions: name, selection, upload (server-generated path; client name/type ignored; magic-byte check; orphan cleanup), remove |
| `src/features/profile/components/profile-forms.tsx` | Name form and Photo / Emoji / Icon / Initials picker |
| `src/app/(dashboard)/profile/page.tsx` | `/profile` for every active employee; account fields are read-only |
| Header, directory table, employee detail, `EmployeeAvatar` | Render the resolved avatar; without one, Phase 3/4 rendering is unchanged |
| `next.config.ts` | Server Action body limit 3 MB (upload limit is 2 MB) |

### Verification

| Check | Result |
| --- | --- |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm test` | 164/164 (150 existing + 14 new) |
| `pnpm test:db` | 280/280 in five files (187 existing + 93 new) |
| `pnpm test:integration` | 87/87 (82 existing + 5 new, real Storage uploads) |
| `pnpm build` | Pass (`/profile` route added) |
| Local `db lint` | No errors; only the two pre-existing Phase 5 unused-variable warnings |
| Browser (production build on 127.0.0.1:3105) | Developer: emoji, icon and photo upload update the header and profile; a disguised SVG named `.png` is rejected; photo kept after switching to an icon. Admin: directory shows the developer's icon. Phone width 375px with no horizontal scroll. No console errors |

Existing tests changed only additively: the detail-page test mocks the new avatar loader (and asserts it is not called for Developers), and the TS test loader exposes `File`, `Blob` and `crypto`. Integration fixtures, their objects and audit rows were removed; local data still has 30 profiles with fingerprint `9a6ebfe6d7a88ed5bdd80c336b94ca1c` and 39 audit rows. Browser verification left the seeded `dev@cyclo.test` account with an icon avatar, one uploaded photo and three `SELF_AVATAR_UPDATED` audit rows.

### Open items for Phase 7

- Uploaded photos keep their embedded metadata (EXIF, possibly location). Stripping it needs image re-encoding; deferred.
- Avatars of deactivated employees remain in Storage (visible to SA/PM only).
- Hosted deployment of all migrations and the bucket remains unapproved.


### Follow-up: direct self-updates revoked (approved 2026-11-24)

Migration `20261124120000_revoke_direct_profile_updates.sql` (applied locally) revokes UPDATE on `public.profiles` from `authenticated` (the Phase 1 `full_name`/`avatar_url` column grant and any table-level UPDATE) and drops the now-unreachable policy "Active employees can update their own profile". Self-service edits now go only through the audited RPCs; Super Admins keep the Phase 4 admin RPCs. No application code used the direct path.

Four existing assertions changed meaning on purpose, each now asserting the stricter behaviour: Phase 2 pgTAP (grant now absent; own-row direct update now denied and the name changes through `update_my_profile`; plan 53 → 55), Phase 4 pgTAP (direct update of another row now fails with 42501 instead of affecting zero rows), the Phase 4 integration test (same), and the Phase 6 pgTAP grant checks. New checks cover direct `full_name`/`avatar_url` writes over SQL and HTTP.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | Pass |
| `pnpm test` | 164/164 |
| `pnpm test:db` | 286/286 |
| `pnpm test:integration` | 87/87 |
| `pnpm build` | Pass |

Local data: 30 profiles (same fingerprint); 42 audit rows (39 before Phase 6 plus the three browser-verification rows for `dev@cyclo.test`).


---

## Phase 7 — Final review (local only)

Full report: [PHASE7_REVIEW.md](PHASE7_REVIEW.md).

- Review: all suites, migration replay, advisors, dependency audit, bundle secret scan, route × role matrix. Findings: 1 High, 4 Medium, 6 Low, 5 Info.
- Approved fixes applied locally on 2026-11-24:
  - **H1**: migration `20261124140000_uninvited_accounts_inactive.sql`. Accounts created without a database invitation get an inactive DEVELOPER profile; metadata ignored; existing profiles unchanged.
  - **M1**: security headers in `next.config.ts` (CSP `frame-ancestors 'none'` and friends, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy; X-Powered-By removed).
- Final results: lint and typecheck pass; unit 164/164; database 315/315; integration 98/98; production build pass; no security advisories.
- Still open (need approval): M2 deployment guards, M3 hosted migrations, M4 password policy, HSTS / script CSP, L1–L6. No commit, push, merge or deployment.
