# CYCLO — Production deployment plan

Prepared 2026-11-25 from commit `7fd9860` (`feature/profile-management`, clean working tree). **Nothing in this document has been executed against hosted Supabase or any hosting platform.** Every hosted step needs explicit approval first.

Hosted project: `Cyclo` (`jbcvznfxycngysxwtbsz`). Its last inspection (Phase 1, read-only) found: the two Phase 1 migrations applied manually through the SQL editor, an **empty** `supabase_migrations.schema_migrations`, one active Super Admin (`full_name`/`onboarded_at` NULL), no Storage buckets, leaked-password protection off. It has not been re-inspected since, so pre-flight checks below confirm this before anything is applied.

---

## 1. Status

### Complete and verified locally

| Area | Verified by (latest results, unchanged code since) |
| --- | --- |
| Authentication, login/logout, protected routes | Unit, integration, route × role matrix, browser |
| Employee directory, search, filters, pagination | pgTAP, integration, browser |
| Employee management (name, avatar URL, code, role, status, Git Organizer) + audit | pgTAP, integration |
| Invitations (create, list, resend, revoke, expiry) and onboarding | pgTAP, real Auth/Mailpit/callback integration, browser |
| Own profile, avatar selection (photo / emoji / icon / initials), private Storage | pgTAP, Storage integration, browser |
| Role-based access on every route | `security-matrix.local.mjs` (anonymous, inactive, uninvited, Developer, PM, Super Admin) |
| Security fixes H1 (uninvited accounts inactive) and M1 (headers) | pgTAP + integration + browser |
| Production build | Pass |

Latest full run (2026-11-24, same code as commit `7fd9860`): lint and typecheck pass; unit 164/164; database 315/315; integration 98/98; production build pass; no security advisories; no dependency vulnerabilities. Not re-run for this document because no application code, migration or test changed since.

### Genuinely blocking deployment

| # | Blocker | Type | Needs |
| --- | --- | --- | --- |
| B1 | ~~Invitation sending hard-wired to local Supabase~~ — **resolved locally 2026-11-25** (not yet committed). `admin.server.ts` now accepts a local pairing or a hosted pairing (`https://<ref>.supabase.co` + explicit `https` `CYCLO_APP_URL`); see section 4.4. | Done | Commit and merge (you). |
| B2 | ~~9 migrations missing on hosted~~ — **done 2026-11-25**: history repaired for migrations 1–2, migrations 3–11 applied with `db push`, post-checks passed (section 3.6). | Done | — |
| B3 | Hosted Auth: **partly done 2026-11-25** — public sign-ups off, link expiry 3600 s, Gmail custom SMTP (smtp.gmail.com:465, sender CYCLO) and the Invite / Magic Link templates configured and verified read-only. Remaining: Site URL and the exact `<domain>/auth/confirm` redirect URL after Vercel, then a real invitation test (verifies delivery and template bodies). | Partly done | Vercel domain |
| B4 | **Hosting target and domain not decided.** | Decision | Your choice of platform and production domain. |
| B5 | **Server secret not provisioned**: a hosted secret key (`sb_secret_…`) must be created and placed in the hosting environment. | Dashboard + hosting config | You create and paste it; never in chat or Git. |

Not blocking but strongly recommended during the same change window (configuration only, no code): disable public sign-ups (H1 is already fixed in the database), set password minimum length 12 and enable leaked-password protection (M4), set Auth OTP/invite expiry to 3600 s.

---

## 2. Migration inventory

All files are in `supabase/migrations/`. Order is the filename timestamp; it is strict.

| # | Migration | Purpose | Depends on | Hosted |
| --- | --- | --- | --- | --- |
| 1 | `20261119120000_create_employee_profiles` | `private` schema, `app_role`, `profiles`, RLS, Auth triggers, `current_app_role`, `provision_super_admin` | — | **Applied** (manually) |
| 2 | `20261120095347_protect_last_active_super_admin` | Last-active-Super-Admin counter and triggers | 1 | **Applied** (manually) |
| 3 | `20261120130000_employee_directory_read_rpcs` | NOLOGIN owner role `cyclo_employee_api`, `request_user_id` bridge, `list_employees`, `get_employee`, `admin_get_employee`, `get_my_profile`; narrows direct SELECT to columns | 1 | Pending |
| 4 | `20261121042440_employee_admin_mutations_audit` | `private.employee_audit_log`, five admin mutation RPCs | 3 | Pending |
| 5 | `20261121095459_employee_mutation_security_hardening` | Authorization-before-lock helper, avatar URL validator | 4 | Pending |
| 6 | `20261121101643_employee_invitations_onboarding` | `employee_invitations`, `profiles.requires_onboarding` (default `false`), invitation/onboarding RPCs, Auth trigger replacement, onboarding guard trigger, audit extension | 1, 3, 4 | Pending |
| 7 | `20261121103439_invitation_acceptance_expiry_guard` | Expiry and identity re-check after lock | 6 | Pending |
| 8 | `20261121103735_invitation_resend_recovery` | Resend keeps ACCEPTED/ONBOARDING | 6 | Pending |
| 9 | `20261124100000_own_profile_avatars` | Avatar columns, private `avatars` bucket, `storage.objects` policies, self-service RPCs, audit actions | 3, 4, 6; Storage schema | Pending |
| 10 | `20261124120000_revoke_direct_profile_updates` | Removes direct self-UPDATE on `profiles` | 1, 9 | Pending |
| 11 | `20261124140000_uninvited_accounts_inactive` | Uninvited Auth users get an inactive profile (H1) | 6 | Pending |

Every pending migration except #3 contains its own explicit transaction (`begin … commit`). #3 has no transaction block: if it is ever applied through the SQL editor, wrap it in `begin;` … `commit;` so a failure leaves nothing half-applied. Migrations 3–9 use PostgreSQL 16+ role-grant syntax (`with inherit false, set true`); local runs PostgreSQL 17.

### Effect on existing hosted data
- The existing Super Admin keeps role and active status. `requires_onboarding` is added as `false` for every existing row, so the account is grandfathered (no onboarding prompt, no backfill, no email-specific exception).
- Avatar columns default to `avatar_kind = 'default'`; nothing else is written to `profiles`.
- No row is deleted. New objects only: one role, private tables, functions, policies, one bucket.

---

## 3. Exact execution plan for the database (do not run until approved)

### 3.1 Pre-flight (read-only, hosted SQL editor)
```sql
show server_version;                                         -- must be 16 or later
select count(*) from supabase_migrations.schema_migrations;  -- expected 0
select exists (select 1 from pg_roles where rolname = 'cyclo_employee_api');  -- expected false
select count(*), count(*) filter (where is_active), count(*) filter (where role = 'SUPER_ADMIN' and is_active) from public.profiles;
select count(*) from storage.buckets where id = 'avatars';   -- expected 0
```
Stop if any result differs; the plan must be revised.

### 3.2 Backup
Take a backup before any change (Dashboard → Database → Backups if available on the plan, or a local dump you run yourself with the database password):
```powershell
npx --yes supabase@3.2.0 db dump --remote=jbcvznfxycngysxwtbsz -f backup-schema.sql
```
```powershell
npx --yes supabase@3.2.0 db dump --remote=jbcvznfxycngysxwtbsz --data-only -f backup-data.sql
```
Keep both files outside the repository.

### 3.3 Apply (recommended: CLI, records history)
Run from the repository root at commit `7fd9860` or later. The CLI asks for the database password; enter it yourself.
```powershell
npx --yes supabase@3.2.0 link --project-ref jbcvznfxycngysxwtbsz
```
```powershell
npx --yes supabase@3.2.0 migration repair --status applied 20261119120000 20261120095347 --remote
```
```powershell
npx --yes supabase@3.2.0 db push --remote --dry-run
```
The dry run must list exactly migrations 3–11 above, in order. Then:
```powershell
npx --yes supabase@3.2.0 db push --remote
```
Do **not** use `--include-seed`, `--include-all`, `config push` or `db reset` against the hosted project. The local `supabase/config.toml` contains local-only URLs and must not be pushed.

Alternative (no CLI): paste files 3–11 one at a time into the SQL editor in order, then record history with the `migration repair --status applied` command for all eleven versions.

### 3.4 Post-checks (read-only)
```sql
select version from supabase_migrations.schema_migrations order by version;  -- 11 rows
select rolname, rolcanlogin, rolbypassrls from pg_roles where rolname = 'cyclo_employee_api';  -- f, f
select id, public, file_size_limit from storage.buckets where id = 'avatars';  -- private, 2097152
select role, is_active, requires_onboarding from public.profiles;  -- existing Super Admin unchanged, false
```
Then run `npx --yes supabase@3.2.0 db advisors --remote --type security` and confirm no new findings.

### 3.5 Rollback
Migrations are forward-only; each file ends with a commented manual rollback. The practical rollback is restoring the 3.2 backup. Because the new schema is additive, the existing Super Admin login keeps working even if later steps are paused.

---

## 4. Environment configuration

### 4.1 Next.js (hosting platform environment)

| Variable | Scope | Value / source |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Build and runtime, public | `https://jbcvznfxycngysxwtbsz.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Build and runtime, public | Dashboard → Project Settings → API Keys → publishable key (`sb_publishable_…`) |
| `SUPABASE_SECRET_KEY` | Runtime, **server only** | Dashboard → API Keys → create a secret key (`sb_secret_…`; legacy service-role JWTs are refused in production). Never `NEXT_PUBLIC_`, never in Git or chat |
| `CYCLO_APP_URL` | Runtime, server only | **Required in production.** Exact production origin, e.g. `https://cyclo.example.com`: https, default port, public DNS name, no path/query/credentials |

`NEXT_PUBLIC_*` values are inlined at build time: set them before building. Node.js 22 or later is required (`package.json` engines).

### 4.2 Hosted Supabase Auth (Dashboard → Authentication)

| Setting | Value |
| --- | --- |
| URL Configuration → Site URL | `<CYCLO_APP_URL>` |
| URL Configuration → Redirect URLs | `<CYCLO_APP_URL>/auth/confirm` (exact) |
| Sign In / Providers → Allow new users to sign up | Off |
| Email → Confirm email | On (default) |
| Email Templates → Invite user | Subject "You are invited to CYCLO", body from `supabase/templates/invite.html` |
| Email Templates → Magic Link | Subject "Continue your CYCLO onboarding", body from `supabase/templates/onboarding-resume.html` |
| Email Templates → Reset Password | Subject "Reset your CYCLO password", body from `supabase/templates/password-recovery.html` (links to `{{ .SiteURL }}/auth/recovery`; uses the Site URL, so it follows the environment) |
| Email OTP / invite expiry | 3600 seconds (matches the one-hour invitation) |
| Password: minimum length | 12 (recommended, M4) |
| Password: leaked password protection | On (recommended, M4) |

### 4.3 Gmail SMTP (Dashboard → Authentication → Emails → SMTP Settings)

| Setting | Value |
| --- | --- |
| Host / Port | `smtp.gmail.com` / `465` (SSL/TLS) |
| Username | The full sending Gmail address |
| Password | A Google App Password for that account (2-Step Verification required), entered only here |
| Sender email / name | Same Gmail address / `CYCLO` |
| Rate limit (Auth → Rate Limits) | Raise "emails per hour" above the default to suit invitations |

The application itself needs no SMTP variables.

### 4.4 Invitation target validation (B1)

`src/lib/supabase/invitation-origins.ts` (pure, unit tested) decides where the Auth Admin client may connect and which link it writes into emails. It runs on every invitation and resend.

| Pairing | NEXT_PUBLIC_SUPABASE_URL | CYCLO_APP_URL | Secret key |
| --- | --- | --- | --- |
| Local | loopback host (`localhost`, `127.0.0.1`, `[::1]`), http/https, any port | loopback origin; defaults to `http://127.0.0.1:3000` | `sb_secret_…` or local service-role JWT |
| Production | exactly `https://<20-char ref>.supabase.co`, default port | required; `https`, default port, public DNS name | `sb_secret_…` only |

Rejected: any other Supabase host (look-alikes, other domains, subdomains), `http` or explicit ports in production, IP-literal or single-label production hosts, credentials, paths, queries, fragments, whitespace/backslashes, a missing production `CYCLO_APP_URL`, and mixed pairings (hosted project → loopback links, local project → production or LAN links). Errors never echo the configured values; a rejected configuration surfaces to the Super Admin as the existing safe "email delivery failed" message and the reservation stays resendable. The emailed link is always `<CYCLO_APP_URL>/auth/confirm`, which must also be the exact entry in the hosted Auth redirect allow-list (4.2).

---

## 5. Step-by-step deployment guide

1. **Approvals and decisions** — choose hosting platform and domain (B4), schedule a change window.
2. **Commit and merge** the B1 change (implemented and tested locally on 2026-11-25) to `main` (you).
3. **Hosted Supabase preparation** — run the 3.1 pre-flight queries; take the 3.2 backup; create the secret key (B5).
4. **Database migrations** — 3.3 (repair two versions, dry run, push), then 3.4 post-checks and advisors.
5. **Auth configuration** — 4.2: Site URL, redirect URL, disable sign-ups, templates, expiry, password policy.
6. **Gmail SMTP** — 4.3; send one test invitation to an address you control.
7. **Environment variables** — 4.1 in the hosting platform (production scope only).
8. **Next.js deployment** — deploy `main` with build command `pnpm build` and start `pnpm start` (or the platform's Next.js preset), Node 22+.
9. **Domain / DNS** — add the production domain in the hosting platform, create the DNS record it requests (CNAME or A), wait for HTTPS. If the domain differs from what was configured in steps 5 and 7, update Site URL, redirect URL and `CYCLO_APP_URL`, then redeploy.
10. **Production smoke test** (section 6).

## 6. Production smoke test

1. Sign in as the existing Super Admin → dashboard loads; Employees page lists employees (no `PGRST202`).
2. Open an employee → Administration card visible; change a harmless field (e.g. employee code on a test account) and revert.
3. Invite a test address you control as Developer → email arrives from Gmail → link opens `<domain>/auth/confirm` → set password → enter name → dashboard.
4. As that Developer: Employees link hidden, `/employees` shows not-found; `/profile` works; choose an emoji, upload a small photo, remove it.
5. As Super Admin: the new employee appears active with the Developer role; deactivate the test account → its next request is sent to login.
6. Check response headers on `/login` (CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY`, no `X-Powered-By`).
7. Run `db advisors --remote --type security` again.

## 7. Remaining risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Hosted state differs from the Phase 1 snapshot | Migration failure mid-way | Pre-flight 3.1; dry run; backup 3.2; each file is transactional |
| Gmail sending limits / App Password revoked | Invitations stop arriving | Monitor; resend flow exists; consider a transactional mail provider later |
| Auth redirect URL mismatch | Invite links fall back to Site URL and fail | Exact `/auth/confirm` entry; smoke test step 3 |
| Single Super Admin | Lock-out if that account is lost | Invite a second Super Admin right after go-live |
| No self-service password reset (L6) | Forgotten passwords need an administrator | Known limitation; reset via Supabase Dashboard |
| Open low findings L1–L5, M1 follow-ups (HSTS, script CSP) | Minor hardening gaps, no data exposure | Accepted for go-live per scope decision |
| `.claude/launch.json` and local scripts in the repository | None in production (dev only) | — |

---

## 3.6 Hosted migration record (2026-11-25)

Executed with explicit approval, against project `Cyclo` (`jbcvznfxycngysxwtbsz`, PostgreSQL 17.12), from commit `6159e1b`.

1. **Preflight (read-only):** one profile (active Super Admin), one Auth user; all 7 functions from migrations 1–2 hash-identical to the repository, plus their triggers, policies, constraints, indexes, grants and the Super Admin counter (1, consistent). No `supabase_migrations` schema, no `cyclo_employee_api`, no buckets. Only extra object: Supabase's `public.rls_auto_enable`.
2. **Backup:** Pro plan; recent daily backups confirmed by the owner in the Dashboard.
3. **History:** `migration repair --status applied 20261119120000 20261120095347 --remote`.
4. **Dry run:** exactly migrations 3–11; no seeds, no roles.
5. **Push:** `db push --remote --yes` applied all nine without errors.
6. **Post-checks:** 11 versions in history; `cyclo_employee_api` NOLOGIN/no BYPASSRLS/no INHERIT, only `postgres` membership without SET/INHERIT; `avatars` bucket private, 2 MiB, JPEG/PNG/WebP; 3 Storage policies; Super Admin unchanged (SUPER_ADMIN, active, `requires_onboarding = false`, `avatar_kind = default`), counter 1; no SECURITY DEFINER function without a pinned search path; RLS on every public/private table; `authenticated` has column SELECT only and no UPDATE on `profiles`; H1 trigger in place; 0 audit rows, 0 invitations.
7. **Security advisors:** nothing from the new migrations. Pre-existing: `public.rls_auto_enable` executable by anon/authenticated (Supabase-created event-trigger helper), leaked-password protection off (M4, Auth setting), INFO "RLS enabled, no policy" on `private.super_admin_guard` (intentional: no API access).

Not changed: Auth settings, SMTP, the existing Super Admin's data, application hosting.

## 3.7 Password recovery (2026-11-25, local code; hosted template pending)

Recovery emails now link to `<Site URL>/auth/recovery?token_hash=…&type=recovery` (PKCE `?code=` also accepted). The callback verifies the link and opens `/reset-password`, which requires a signed email-link session from the last 15 minutes, sets the new password (12+ characters, max 72 bytes), signs the account out everywhere and returns to `/login?notice=password_updated`. **Hosted action needed:** paste `supabase/templates/password-recovery.html` into Authentication → Emails → Templates → Reset Password with subject "Reset your CYCLO password". No redirect-URL entry is needed for this link. Until the production Site URL is set, hosted recovery links point to `http://localhost:3000/auth/recovery`, which works with the app running locally against hosted (`npm run dev`).

## 3.8 Forgot password (2026-11-25, local code)

User flow: login → **Forgot password?** → `/forgot-password` (work email; always answers "If an account exists for this email, you will receive a password reset link."; constant minimum response time; Auth errors logged by code only) → `resetPasswordForEmail(email, { redirectTo: <CYCLO_APP_URL>/auth/recovery })` through the existing Gmail SMTP → email from the Reset Password template → `/auth/recovery` (token hash or PKCE code) → `/reset-password` (requires a signed email-link session from the last 15 minutes; 12+ characters, ≤ 72 bytes, matching, strength meter) → global sign-out → `/login?notice=password_updated`.

The redirect origin comes from the same validated configuration as invitations (`CYCLO_APP_URL`, never request headers). If the pairing is not valid (for example a local dev server against the hosted project), no `redirectTo` is sent and Supabase uses the Site URL, which the template links to anyway.

Hosted Dashboard steps (manual, after the Vercel deployment at `https://cyclo-alpha.vercel.app`):
1. Authentication → Emails → Templates → **Reset Password**: subject `Reset your CYCLO password`, body = `supabase/templates/password-recovery.html`.
2. Authentication → URL Configuration → **Site URL** = `https://cyclo-alpha.vercel.app`.
3. Authentication → URL Configuration → **Redirect URLs**: add `https://cyclo-alpha.vercel.app/auth/confirm` and `https://cyclo-alpha.vercel.app/auth/recovery` (exact).
4. Vercel environment: `CYCLO_APP_URL=https://cyclo-alpha.vercel.app` (server-only), plus the other variables in section 4.1.
