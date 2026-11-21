# CYCLO

Engineering Delivery Management by AyaTech.

**Plan. Build. Review. Deliver.**

CYCLO is an internal engineering project management platform inspired by Linear and Jira. This repository contains the frontend foundation, Supabase SSR session handling, email/password login, and a protected identity dashboard. Project workflows and GitHub integrations will be introduced in separate tasks.

## Technology stack

- Next.js 16 with the App Router and React 19
- TypeScript with strict checking and the `@/*` source alias
- Tailwind CSS v4 through PostCSS
- ESLint with Next.js Core Web Vitals and TypeScript rules
- Lucide React icons, `clsx`, and `tailwind-merge`
- Supabase JavaScript and SSR clients for authentication and profile authorization
- pnpm 11 with a committed lockfile

## Getting started

Use Node.js 22 or newer (Node.js 24 LTS recommended) and pnpm 11.25.0. The package manager version is recorded in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [localhost:3000](http://localhost:3000).

## Environment variables

Copy `.env.example` to `.env.local` and provide the existing Supabase project's public configuration:

```sh
cp .env.example .env.local
```

In PowerShell, use `Copy-Item .env.example .env.local`.

The example contains variable names with blank values only:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable client key |

Runtime requests require these values for the existing SSR proxy. The build does not connect to Supabase or require an authenticated account. Variables prefixed with `NEXT_PUBLIC_` are visible to the browser; never put secret or service-role keys in them. Keep credentials out of source control.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the development server |
| `pnpm lint` | Run ESLint; warnings fail the check |
| `pnpm typecheck` | Run TypeScript without emitting files |
| `pnpm build` | Create the production build and check types |
| `pnpm start` | Serve the production build after `pnpm build` |
| `pnpm test` | Unit tests (mocked Supabase) |
| `pnpm test:db` | pgTAP database tests against the **local** Supabase stack (rolled back) |
| `pnpm test:integration` | HTTP tests against the **local** stack; first run `npx supabase status -o env > .env.supabase-local` |
| `pnpm db:types` | Regenerate `src/types/database.ts` from the **local** schema |
| `pnpm db:seed:local` | Seed demo employees into the **local** stack; role logins are written to the gitignored `.env.seed-local` |
| `pnpm dev:local [port] [--prod]` | Run the app against the **local** stack without editing `.env.local` (`--prod` builds and runs `next start`) |

Next.js 16 runs lint separately from its build. Run both before handing off changes.

The development and build scripts explicitly use Webpack. Turbopack's CSS worker failed to start in the initial Windows environment, including outside the sandbox. Re-evaluate this fallback when updating Next.js. ESLint 9.39.5 is retained because the plugins bundled by `eslint-config-next` do not yet declare support for ESLint 10; npm currently marks ESLint 9 as unsupported. Upgrade the lint toolchain together when plugin compatibility is available.

## Project structure

```text
src/
├── app/
│   ├── (auth)/login/       # Email/password sign-in
│   ├── (dashboard)/        # Protected layout and dashboard page
│   ├── api/                # Reserved for future route handlers
│   ├── globals.css         # Tailwind theme and global defaults
│   ├── layout.tsx          # Root layout and metadata
│   └── page.tsx            # Temporary initialization screen
├── components/
│   ├── ui/                 # Reusable UI primitives
│   ├── layout/             # Shared layout components
│   └── shared/             # Cross-feature components
├── features/auth/          # Server actions, profile guard, form, validation
├── lib/
│   ├── supabase/           # Existing browser/server clients and SSR proxy helper
│   ├── utils/
│   │   └── cn.ts           # Conditional Tailwind class merging
│   └── constants/
├── hooks/
├── types/
└── config/
```

Unused reserved directories contain `.gitkeep` so Git preserves the requested structure. Add files as each feature is developed.

## Authentication and authorization

- `/` remains the public initialization screen. `/login` is public; the proxy protects every other matched application path by default, including future API paths. Internal Next.js assets and named metadata files are excluded. Public paths must be added deliberately.
- The existing SSR client factories are reused. The proxy still calls `getClaims()` immediately after creating its client and writes refreshed cookies to both the request and response. Redirects preserve those cookies and cache headers. Auth responses use `private, no-store`.
- Login is a Server Action using `signInWithPassword()`. Email and password are validated server-side. After authentication, `getAccess()` verifies the user with `getUser()` and reads that user's `public.profiles` row under existing RLS. Missing/inactive profiles, unsupported roles, and backend failures never grant access. A rejected login signs out the newly created local session.
- The profile's `role` is the only source for `SUPER_ADMIN`, `PROJECT_MANAGER`, or `DEVELOPER`; user metadata and form inputs never authorize a role. No role-editing operation or privileged key is introduced. Existing grants, RLS policies, migrations, and schema remain unchanged.
- The dashboard layout and page independently invoke `requireActiveProfile()`. Every future protected page, Route Handler, data operation, and Server Action must call this guard close to its data access; layouts alone are insufficient. Pass an explicit list of allowed roles for a role-restricted operation, for example `await requireActiveProfile(["SUPER_ADMIN"])`. All three valid roles can use the current dashboard.
- Checks are uncached between requests, so profile deactivation is checked again on subsequent requests and actions. Previously rendered content cannot be recalled from an already open browser tab.
- Logout is a POST Server Action calling `signOut({ scope: "local" })`: it signs out this browser session through the SSR cookie adapter, clears the Next.js layout cache, and redirects to `/login`. A failed logout remains visible with a retry control. Logout deliberately requires no active profile so deactivated users can clear their session. Next.js applies its Server Action origin checks; no GET logout endpoint exists.
- An authenticated, authorized user visiting `/login` goes to `/dashboard`, except while displaying a logout failure so it can be retried. Database/Auth availability failures show a generic retry message without backend error details.

Run the focused authorization and input-validation unit tests with Node.js 22.18+ or 24:

```sh
node --experimental-strip-types --test tests/auth.test.mjs tests/ssr-proxy.test.mjs
```

These tests use mocked Auth/database responses and simulated SSR cookie refreshes; they do not verify the hosted RLS policies or real Supabase sessions. Proxy tests exercise the existing helper with real Next.js request/response objects and verify redirect cookies and cache headers. Before deployment, manually test valid login for all three roles, wrong credentials, missing/inactive profiles, runtime deactivation, expired-token refresh, logout and browser Back, direct protected URLs, disabled/deleted Auth accounts, and Auth/database failure recovery. Use pre-provisioned test employees; no invitation or signup flow is included.

## Design system

`src/app/globals.css` defines the colour tokens once per theme as CSS variables and maps them to Tailwind utilities with `@theme inline`. Always use the semantic utilities (`bg-background`, `bg-surface`, `bg-surface-muted`, `text-text-primary`, `text-text-secondary`, `text-text-muted`, `border-border`, `border-border-strong`, `bg-primary`, `text-primary-foreground`, `hover:bg-primary-hover`, `ring-ring`, `text-success|warning|danger`) so components work in both themes without `dark:` variants. Put `text-primary-foreground` on primary fills, never `text-white`.

| Token | Light | Dark |
| --- | --- | --- |
| Background / surface / surface-muted | `#F6F7F9` / `#FFFFFF` / `#F1F3F6` | `#0A0C10` / `#12151B` / `#191D25` |
| Border / border-strong | `#E3E6EB` / `#CBD2DC` | `#262B35` / `#353C49` |
| Text primary / secondary / muted | `#0F172A` / `#475569` / `#64748B` | `#E8EBF0` / `#A1A9B8` / `#7F8899` |
| Primary / hover / foreground | `#4F46E5` / `#4338CA` / `#FFFFFF` | `#8B8CF8` / `#A5A6FB` / `#0A0C10` |
| Success / warning / danger | `#047857` / `#B45309` / `#DC2626` | `#34D399` / `#FBBF24` / `#F87171` |
| Danger hover / foreground (destructive buttons) | `#B91C1C` / `#FFFFFF` | `#FCA5A5` / `#0A0C10` |
| Brand gradient (login panel) | `#312E81` → `#4338CA` → `#6D28D9` | `#1E1B4B` → `#312E81` → `#4C1D95` |

Every text/background pair meets WCAG 2.1 AA (4.5:1) in both themes.

**Light and dark mode.** The theme is **System** by default (follows the operating system through `prefers-color-scheme`, pure CSS). Users can force Light or Dark with the toggle on the login page and in the app header; the choice is stored in the non-sensitive `cyclo-theme` cookie and rendered by the server as `<html data-theme>`, so the first paint is already correct (no flash, no inline script). Code: `src/lib/theme` and `src/components/theme/theme-toggle.tsx`. The explicit and system dark palettes are duplicated in CSS and kept identical by `tests/theme.test.mjs`.

The theme uses a system font stack, a 4px spacing unit, shared corner radii, small and large shadows tuned per theme, visible keyboard focus rings, and honours `prefers-reduced-motion`. No font downloads or component framework are required.

Use the shared class helper when combining conditional or overridable classes:

```tsx
import { cn } from "@/lib/utils/cn";

const className = cn("text-text-primary", isMuted && "text-text-secondary");
```

## Development conventions

- Keep changes scoped to the requested phase. Invitations, passkeys, business APIs, and project workflows require separate tasks.
- Keep pages and layouts as Server Components by default. Add `"use client"` only when browser behavior requires it.
- Put feature-specific code under `src/features`; promote shared code into `components`, `hooks`, or `lib` when needed.
- Use PascalCase component names, camelCase functions, and descriptive kebab-case filenames. Follow App Router filenames for routes.
- Use `@/` for source imports and `import type` for type-only dependencies.
- Prefer semantic design tokens, accessible HTML, and responsive Tailwind utilities over scattered values.
- Use `cn` for conditional class composition; do not add a UI framework without a concrete requirement.
- Use pnpm exclusively and commit `package.json` with `pnpm-lock.yaml` after dependency changes.
- For Antigravity, Codex, and Claude handoffs, inspect existing work first, keep changes scoped, and report lint, type checking, and build results. Do not commit credentials or generated build output.
