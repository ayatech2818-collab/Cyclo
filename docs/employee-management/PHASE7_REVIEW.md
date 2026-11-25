# Phase 7 — Final testing and security review

Date: 2026-11-24 · Branch: `feature/profile-management` (HEAD `6cf3056` plus uncommitted Phase 6 work) · Scope: Phases 1–6, **local Supabase only**. Hosted Supabase was not accessed; hosted configuration is therefore listed as unverified.

## 1. Summary

The database, RPC and Storage security model holds up under review and testing. No vulnerability was found that exposes data or allows privilege escalation **on the local stack**. H1 and M1 were fixed locally on 2026-11-24 (see section 7). M2–M4 (deployment work and hosted password policy) remain open and need separate approval.

| Severity | Count | Items | Status |
| --- | --- | --- | --- |
| High | 1 | H1 | **Fixed locally** (hosted sign-up setting still to confirm at deployment) |
| Medium | 4 | M1–M4 | M1 and M2 **fixed locally**; M3–M4 open |
| Low | 6 | L1–L6 | Open |
| Info | 5 | I1–I5 | Noted |

## 2. Verification results

| Check | Result |
| --- | --- |
| `pnpm lint` (zero warnings) | Pass |
| `pnpm typecheck` | Pass |
| `pnpm test` (unit / server-render) | 164/164 |
| `pnpm test:db` (pgTAP, 5 files) | 286/286 |
| `pnpm test:integration` (Auth, PostgREST, Storage, Mailpit, app) | 94/94, including the new route × role matrix (7) |
| `pnpm build` (production) | Pass, 11 routes |
| Migration replay (`supabase db diff`, shadow database from all 10 migrations) | Applies cleanly; only whitespace drift (I1) |
| `supabase db advisors` (security + performance) | No security findings; 1 performance WARN (I2) |
| `supabase db lint` | No errors; 2 pre-existing warnings (I3) |
| Dependency audit (`pnpm audit`, prod and dev) | No known vulnerabilities |
| Client bundle secret scan (`.next/static`) | No secret/service keys |
| Tracked secret files | None (`.env*` ignored except `.env.example`) |
| Public sign-up probe (local Auth) | `422 signup_disabled` |
| Local data after all runs | 30 profiles, same fingerprint `9a6ebfe6…`; test fixtures, objects and audits removed |

## 3. Security review

### 3.1 Database functions and grants
- All 24 SECURITY DEFINER functions in `public`/`private` pin `search_path=''`. 22 are owned by `cyclo_employee_api` (NOLOGIN, no BYPASSRLS, no INHERIT/SET membership for any login role); `private.current_app_role` and the two bridges are owned by `postgres` and narrowly granted.
- No function in `public` or `private` is executable by `anon` or `PUBLIC`.
- `authenticated` can execute only the 23 public SECURITY INVOKER wrappers, their private implementations, and `current_app_role`. Internal helpers (`lock_*`, `apply_my_avatar`, `require_employee_actor`, Auth/Storage bridges) are owner-only.
- No RPC takes an actor id or role; identity always comes from `auth.uid()`.

### 3.2 Tables and RLS
- RLS is enabled on every table in `public` and `private`.
- `authenticated`: column SELECT on 7 non-administrative profile columns only; **no** INSERT/UPDATE/DELETE (direct self-updates revoked in `20261124120000`).
- `anon`: no table privileges. `service_role`: full DML on `profiles` (expected, server-only).
- `private.employee_audit_log`: append-only for the RPC owner (actor must equal caller), no read/update/delete for any API role.
- Triggers: invitation linking on `auth.users` insert, email sync, last-active-Super-Admin protection, invitation-profile guard, `updated_at`, TRUNCATE prevention.

### 3.3 Storage
- `avatars` bucket: private, 2 MiB, JPEG/PNG/WebP only.
- Policies: insert only `<own uid>/<uuid>.<ext>`; read own, or any for active SA/PM; delete own; **no update** (no overwrite). All require an active profile.
- Images reach the browser only as 1-hour signed URLs, created with the viewer's own session; the app accepts only signed URLs for this project's avatars bucket.

### 3.4 Authentication and onboarding
- Local Auth: sign-ups disabled, anonymous sign-ins disabled, manual linking disabled, refresh-token rotation on, JWT 1 h.
- Every protected page and Server Action re-reads the caller's active profile per request; inactive users are redirected with `error=denied` even with a valid session.
- Invitation flow: token-hash verification, replay/expiry/revocation checked in the database, role is database-authoritative, invitee inactive until completion, host-relative callback redirect (open-redirect test included).
- Login does not accept a `next` URL; failed authorization signs the new session out.

### 3.5 Application layer
- Five `"use server"` modules; each operation checks the session and role before any database call, and the database re-checks.
- Secret key usage is limited to two `server-only` modules; no client component imports server modules.
- Errors are mapped to fixed messages; raw database/Auth/Storage messages never reach the UI.

### 3.6 Route × role matrix (production build, real sessions)

| Role | /dashboard | /profile | /employees | /employees/[id] | /employees/invitations |
| --- | --- | --- | --- | --- | --- |
| Anonymous | → /login | → /login | → /login | → /login | → /login |
| Inactive | → /login?error=denied | same | same | same | same |
| Developer | 200 | 200 (own) | 404 | 404 | 404 |
| Project Manager | 200 | 200 (own) | 200 | 200, no admin fields | 200, **no data** (L1) |
| Super Admin | 200 | 200 | 200 | 200 + Administration | 200 |

Automated in `tests/integration/security-matrix.local.mjs`.

## 4. Findings

### High
**H1 — Uninvited accounts became active. Status: fixed locally (section 7.1); hosted sign-up setting still to be confirmed at deployment.**
The `auth.users` insert trigger provisions any Auth user that has no matching invitation as an **active DEVELOPER**. Locally this is safe because `enable_signup = false`. Supabase projects allow sign-ups by default; if the hosted project does, anyone holding the public publishable key could create a working Developer account. Required: confirm/disable "Allow new users to sign up" on hosted. Recommended defence in depth (needs approval): change non-invitation provisioning to create **inactive** profiles, so a Super Admin must activate them. Seed and test scripts already set `is_active` explicitly.

### Medium
**M1 — No HTTP security headers. Status: fixed locally (section 7.2); HSTS and a full script CSP remain for deployment.** Responses carry no `X-Frame-Options`/`frame-ancestors` (admin actions could be framed for clickjacking), no `X-Content-Type-Options`, `Referrer-Policy` or HSTS, and expose `X-Powered-By: Next.js`. Recommended: add a headers block in `next.config.ts` (`frame-ancestors 'none'`, `nosniff`, `strict-origin-when-cross-origin`, HSTS on hosted) and `poweredByHeader: false`; a full CSP can follow.

**M2 — Hosted deployment guards. Status: resolved locally 2026-11-25 as deployment blocker B1 (section 8).** Originally: `createAuthAdminClient()` and `invitationCallbackUrl()` accept loopback hosts only, so invitations cannot be sent from a hosted deployment until these are changed to an explicit allowlist of the production origin.

**M3 — Hosted migration history is empty.** Only the two Phase 1 migrations exist on hosted (applied manually). Eight more must be applied in order (`20261120130000` … `20261124120000`). Decide between repairing history (`supabase migration repair --status applied 20261119120000 20261120095347`, then `db push`) and manual application. This also resolves the original PGRST202 error.

**M4 — Password policy.** Local Auth minimum is 6 characters (onboarding enforces 12 in the app; existing accounts and Dashboard-created users are not covered). On hosted: set minimum length 12 and enable leaked-password protection (flagged by the advisor in Phase 1).

### Low
- **L1** — Project Managers receive `200` with the title "Employee invitations | CYCLO" for `/employees/invitations` (page existence disclosed; no invitation data, no form). Fix: move the Super Admin check into a route layout / role-aware metadata.
- **L2** — For SA/PM, malformed and unknown employee ids render the not-found view with a streamed `200` (Phase 3 documented 404 for malformed ids; the production build returns 200). No data is exposed.
- **L3** — After deactivation or a role change, avatar signed URLs already issued stay valid for up to 1 hour, and the user's JWT until expiry; all RPCs, pages and Storage policies re-check `is_active`, so no further data is served.
- **L4** — Uploaded photos keep embedded metadata (EXIF, possibly GPS). Stripping requires server-side re-encoding.
- **L5** — Photos of deactivated employees remain in Storage (visible to SA/PM only).
- **L6** — No self-service password reset; a user who forgets their password needs an administrator (Supabase Dashboard) or a new flow.

### Info
- **I1** — Three Phase 4 functions on the local database differ from the migration file only by one trailing space (the file was trimmed after it was applied). No functional difference; hosted will receive the file version.
- **I2** — Performance advisor: two permissive SELECT policies on `profiles` for `authenticated` (own row, Super Admin). Acceptable at this scale.
- **I3** — `db lint`: two unused-variable warnings in Phase 5 functions (non-functional).
- **I4** — Local-only Auth settings (`enable_confirmations = false`, `secure_password_change = false`, 2 emails/hour, Mailpit) are development values, not production recommendations.
- **I5** — Local data contains user-made test activity (avatar choice and a photo for `wqttiqzusa@lnovic.com`, the browser-check avatar for `dev@cyclo.test`, and invitation accounts "checking 1/2").

## 5. Deployment readiness checklist (requires explicit approval; nothing done)

1. Disable public sign-ups on hosted (H1 is fixed in the database, so an uninvited account is inactive either way; this removes the noise). The H1 migration ships with the others.
2. Apply **M4** password settings; add HSTS (and later a nonce-based script CSP) for the hosted origin (M1 follow-up).
3. Decide the migration-history approach (**M3**); back up hosted; apply the nine migrations in order (`20261120130000` … `20261124140000`); run `db advisors` and the pgTAP suite against a staging copy first if available.
4. Confirm the hosted Super Admin is unaffected: existing profiles get `requires_onboarding = false` and keep their role and status (verified locally with grandfathered accounts).
5. Configure hosted Auth: Site URL and redirect allow-list `<app-origin>/auth/confirm`; invite and magic-link templates from `supabase/templates/`; production SMTP (Gmail App Password, see `INVITATIONS.md`); OTP/invite expiry.
6. Lift **M2** guards to an allowlisted production origin; set server-only `SUPABASE_SECRET_KEY` and `CYCLO_APP_URL` in the hosting environment (never `NEXT_PUBLIC_`).
7. Build with hosted `NEXT_PUBLIC_SUPABASE_URL`/publishable key (the local `--prod` build inlines local values).
8. Smoke test on hosted: login as Super Admin, directory, invitation end to end, onboarding, profile/avatar upload, role matrix.

## 6. New and changed files in Phase 7

| File | Change |
| --- | --- |
| `tests/integration/security-matrix.local.mjs` | New: route × role matrix against the production build (needs the app on `127.0.0.1:3105`) |
| `docs/employee-management/PHASE7_REVIEW.md` | This report |
| `docs/employee-management/PROGRESS.md` | Status table |

No application code, migration or configuration was changed in the review itself; the approved H1/M1 fixes are listed in section 7.

## 7. Approved fixes (2026-11-24, local only)

### 7.1 H1 — uninvited accounts stay inactive

Migration `supabase/migrations/20261124140000_uninvited_accounts_inactive.sql` (new; applied locally with `supabase migration up`, no reset; no existing migration edited) replaces only the body of `private.handle_new_auth_user()`:

| Account created | Before | After |
| --- | --- | --- |
| With a valid PENDING database invitation | Inactive, invited role, `requires_onboarding` | Unchanged |
| Auth invitation without a database invitation | Rejected (`invalid_invitation`) | Unchanged |
| Without any invitation (sign-up, Dashboard, Admin API) | **Active** DEVELOPER | **Inactive** DEVELOPER (default profile still created) |

- Auth user/app metadata is never read; role and status are fixed in the trigger.
- Owner `postgres`, SECURITY DEFINER, `search_path=''`, trigger binding and EXECUTE revocations unchanged.
- Existing profiles untouched (no backfill): 30 profiles, 25 active, same id/role/status fingerprint before and after.
- Activation paths unchanged: a Super Admin uses `admin_set_employee_active` (audited); the owner-only `private.provision_super_admin()` still creates an active Super Admin. Invitation acceptance and atomic onboarding completion are unchanged.
- Test fixtures that relied on "new account = active" now activate their fixture users explicitly (setup only, no assertion changed): five pgTAP files and `tests/integration/invitations.local.mjs`. The seed script already set `is_active` explicitly.

### 7.2 M1 — security headers

`next.config.ts` now sets, for every path (pages, route handlers, proxy redirects, 404s, static assets):

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` (the auth callback keeps its stricter `no-referrer`) |
| `Permissions-Policy` | camera, microphone, geolocation, payment, usb, serial, bluetooth, hid, browsing-topics all disabled |
| `X-Powered-By` | removed (`poweredByHeader: false`) |

The CSP intentionally does not restrict `script-src`, `img-src` or `connect-src` (Next.js inline bootstrap scripts need nonces; avatars and Auth use the Supabase origin). HSTS is left to the hosted deployment.

### 7.3 Verification

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | Pass |
| `pnpm test` | 164/164 |
| `pnpm test:db` | 315/315 in six files (286 + 29 new in `uninvited_accounts.test.sql`) |
| `pnpm test:integration` | 98/98 (94 + 4 new in `security-matrix.local.mjs`) |
| `pnpm build` | Pass |
| `supabase db advisors --type security` | No findings |

Covered: uninvited accounts (with spoofed role/activation metadata) get an inactive DEVELOPER profile, are redirected from every protected route with `error=denied`, are denied every RPC, Storage upload and self-activation; Super Admin activation (audited) and `provision_super_admin` still work; invited accounts still get their invited role pending onboarding; existing active employees keep access; the real invitation callback and onboarding integration tests still pass; headers are present on all response types; signed avatar URLs still load.

Browser check on the production build (`127.0.0.1:3105`): logout and login, avatar photo upload through the Server Action (allowed by `form-action 'self'`) with signed images from the Supabase origin loading, photo removal; no console errors or CSP violations. The admin's test photo was removed; this left two `SELF_AVATAR_UPDATED` audit rows for `admin@cyclo.test` (46 audit rows in total).

### 7.4 Remaining

M2 (deployment guards), M3 (hosted migrations), M4 (password policy), the M1 follow-ups (HSTS, nonce-based script CSP), L1–L6 and the deployment checklist in section 5 — all require further approval.

## 8. Approved fix B1 / M2 — production invitation support (2026-11-25, local only)

- New `src/lib/supabase/invitation-origins.ts`: exact validation of the Supabase URL and `CYCLO_APP_URL` pairing (local loopback, or `https://<ref>.supabase.co` + explicit https public origin with default port); legacy service-role JWTs accepted only locally. Details: DEPLOYMENT.md section 4.4.
- `src/lib/supabase/admin.server.ts` uses it for both the Admin client and the emailed callback URL; the client now connects to the validated origin. Nothing else in the invitation flow changed: database authority, identity binding, expiry, replay protection, onboarding guards and the safe delivery-failure path are untouched.
- Tests: new `tests/invitation-origins.test.mjs` (9 tests: local URLs, production URLs, look-alike/arbitrary Supabase hosts, http/ports/IPs/paths/credentials, missing production origin, mixed pairings, no value echo, secret-key rules, Admin client wiring). The shared TS test loader now also exposes `process` (needed to test environment-based wiring).

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | Pass |
| `pnpm test` | 173/173 (164 + 9) |
| `pnpm test:integration` | 98/98, including the 8 invitation tests (real invite Server Action, Mailpit email, callback, resend, onboarding) against a fresh production build |
| `pnpm test:db` | 315/315 (no database change) |
| `pnpm build` | Pass |

Still open and needing approval: M3 (hosted migrations), M4 (hosted password policy), HSTS / script CSP follow-ups, L1–L6, and the deployment itself.
