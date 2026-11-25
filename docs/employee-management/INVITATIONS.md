# Employee invitations and onboarding

Phase 5 is implemented and tested against local Supabase only. Hosted migration
history, deployment approval, SMTP, Auth settings and hosted profiles are unchanged.

## Local development

1. Start Docker and the existing local Supabase stack. Apply pending migrations
   with the pinned CLI's local-default workflow; never use a remote target or reset.
2. Save local status output in the ignored `.env.supabase-local` file:
   `npx --yes supabase@3.2.0 status -o env > .env.supabase-local`.
3. Run `pnpm dev:local 3000`. For isolated production-build verification, use
   `pnpm dev:local 3105 --prod`. Both callback origins are allowlisted locally.
4. As a local active Super Admin, open Employees → Invite Employee / Manage
   invitations. The mail inbox is [Mailpit](http://127.0.0.1:54324).
5. Open the captured invitation link, set a password, confirm the full name and
   complete onboarding. Passwords require at least 12 characters and at most
   72 UTF-8 bytes. Passwords never enter application database RPCs or audit rows.

`pnpm test:integration` includes the real callback and rendered Server Action
tests. Keep the isolated local app running on `http://127.0.0.1:3105` while running
that suite. It creates disposable users and emails and removes only its own
fixtures, including disposable audit rows through the trusted local database owner.
Normal authenticated/API roles still cannot edit or delete audit records.

## Environment variables

| Variable | Location | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Existing Next.js environment | Local Supabase URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Existing Next.js environment | Public SDK credential; RLS still applies |
| `SUPABASE_SECRET_KEY` | Next.js server environment only | Auth Admin key: `sb_secret_…` or the local legacy service-role JWT accepted by the installed SDK |
| `CYCLO_APP_URL` | Next.js server environment only | Trusted application origin, e.g. `http://127.0.0.1:3000` |

The local runner maps the local status `SECRET_KEY` (or `SERVICE_ROLE_KEY`) into
`SUPABASE_SECRET_KEY` and sets `CYCLO_APP_URL` from the selected port. It strips
other local admin credentials from the child process. No secret value belongs in
`.env.example`, source control or a `NEXT_PUBLIC_` variable. The dedicated Admin
module imports `server-only`, disables session persistence and currently rejects
non-loopback Supabase URLs. Hosted enablement requires the separately approved
deployment change; merely entering hosted credentials is insufficient.

## Database authority and lifecycle

Private invitation records hold normalized email, immutable initial name/role,
inviter, linked Auth UUID, lifecycle timestamps, delivery state and expiry.
Only scoped authenticated RPCs expose fixed DTOs. Active Super Admin checks and
the existing trusted `auth.uid()` bridge determine the actor; no actor ID or caller
role is accepted as an argument. Pending email uniqueness is enforced in PostgreSQL.

The Auth insert trigger links a matching valid pending invitation by email,
ignores editable metadata and creates an inactive profile with the assigned role,
inviter and `requires_onboarding = true`. Auth invitations without an authorized
database record fail closed. Since Phase 7 (H1, `20261124140000`), an account
created without any invitation gets an inactive DEVELOPER profile and has no
access until a Super Admin activates it. Existing profiles have the new flag false; their name, role,
active state and NULL `onboarded_at` are not changed or backfilled.

Lifecycle: PENDING → ACCEPTED → ONBOARDING → COMPLETED. REVOKED is terminal.
An active state whose deadline has passed is exposed as EXPIRED and rejected by
mutation RPCs; no background scheduler is needed to make expiration effective.
Reserving a fresh invitation can persist an expired unlinked record's EXPIRED
state. Resend renews the one-hour deadline, preserving ACCEPTED/ONBOARDING for
session recovery. Resends are rate-limited after confirmed delivery. The role,
email, inviter and initial name cannot be edited after creation.

Supabase Auth generates/sends the initial invite using `inviteUserByEmail`.
Unverified resends use that endpoint again. Verified-but-incomplete invitees use
Auth `signInWithOtp(shouldCreateUser: false)` to send a resume email: Auth will not
re-invite an already verified account. Both email templates route to `/auth/confirm`.
The callback verifies an invite/email token hash, establishes the SSR cookie
session and consults the caller's own database invitation. A new resume token does
not replay invitation acceptance. There is no arbitrary `next` redirect.

Acceptance is locked, bound to the confirmed Auth email and rejects expired,
revoked or replayed transitions. Expiry uses wall-clock time and confirmed identity
is rechecked after waiting for a lock. Password presence is checked through a
private Auth bridge; hashes and tokens never leave Auth. Completion atomically
updates the invitation and the profile, sets `onboarded_at`, activates the employee
and preserves the assigned role. Concurrent submissions permit one completion.

An update trigger prevents normal profile APIs or Phase 4 admin activation/role
RPCs from bypassing incomplete onboarding. Normal routes still require active
profiles. Only the exact callback and onboarding routes bypass that proxy gate;
their handlers independently verify token/session/invitation state. Existing active
accounts, including the existing hosted Super Admin with NULL profile/onboarding
fields, remain grandfathered without an email-specific exception.

The existing append-only employee audit table gains invitation IDs and constrained
invitation actions. Creation, resend, revoke, acceptance, onboarding start and
completion are audited in the same transaction as their database mutations. Email
delivery is an external Auth API operation and cannot share that transaction:
the reservation survives a failed delivery with safe error feedback and a resend
path. A revoke racing a sent email still makes that link unusable in CYCLO.

## Future Gmail SMTP configuration — documentation only

Do this only after hosted deployment and migration-history strategy are approved.
Nothing in this task configures hosted SMTP or asks for Gmail credentials.

In **Supabase Dashboard → Authentication → SMTP Settings**, enable custom SMTP:

| Setting | Value |
| --- | --- |
| Host | `smtp.gmail.com` |
| Port | `465` |
| Encryption | SSL/TLS |
| Username | Full authorized Gmail address |
| Password | Google App Password for that account |
| Sender email | Same authorized Gmail address |
| Sender name | CYCLO / AyaTech |

Enable Google 2-Step Verification and generate an App Password in the account's
own security settings if its policies allow it. Enter that password only in
Supabase SMTP settings, not in Next.js. Google documents account eligibility and
App Password revocation in [App Password help](https://support.google.com/accounts/answer/185833).
Review [Supabase custom SMTP documentation](https://supabase.com/docs/guides/auth/auth-smtp)
for provider configuration and delivery limits.

Before hosted testing, configure the approved production Site URL and exact
`/auth/confirm` redirect URL, and copy the repository's invitation and magic-link
templates into the respective Supabase Auth Email Templates. The one-hour CYCLO
deadline is independent of Auth's token expiry; align Auth's expiry for predictable
email UX. Test delivery with an authorized recipient and ensure link tracking does
not rewrite authentication links. Supabase Auth generates and validates all links;
Gmail only transports the messages. No Nodemailer or SMTP application variables
are needed.
