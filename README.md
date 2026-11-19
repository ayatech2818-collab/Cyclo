# CYCLO

Engineering Delivery Management by AyaTech.

**Plan. Build. Review. Deliver.**

CYCLO is an internal engineering project management platform inspired by Linear and Jira. This repository currently contains the frontend foundation and a temporary initialization screen. Roles, project workflows, Supabase connectivity, and GitHub integrations will be introduced in separate tasks.

## Technology stack

- Next.js 16 with the App Router and React 19
- TypeScript with strict checking and the `@/*` source alias
- Tailwind CSS v4 through PostCSS
- ESLint with Next.js Core Web Vitals and TypeScript rules
- Lucide React icons, `clsx`, and `tailwind-merge`
- Supabase JavaScript and SSR packages installed for future integration
- pnpm 11 with a committed lockfile

## Getting started

Use Node.js 22 or newer (Node.js 24 LTS recommended) and pnpm 11.25.0. The package manager version is recorded in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [localhost:3000](http://localhost:3000).

## Environment variables

Copy `.env.example` to `.env.local` when preparing a future Supabase integration:

```sh
cp .env.example .env.local
```

In PowerShell, use `Copy-Item .env.example .env.local`.

The example contains variable names with blank values only:

| Variable | Future purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable client key |

The initialization screen and build do not require environment values. No Supabase client, session handling, or database connection is configured. Variables prefixed with `NEXT_PUBLIC_` are visible to the browser; never put secret or service-role keys in them. Keep credentials out of source control.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the development server |
| `pnpm lint` | Run ESLint; warnings fail the check |
| `pnpm typecheck` | Run TypeScript without emitting files |
| `pnpm build` | Create the production build and check types |
| `pnpm start` | Serve the production build after `pnpm build` |

Next.js 16 runs lint separately from its build. Run both before handing off changes.

The development and build scripts explicitly use Webpack. Turbopack's CSS worker failed to start in the initial Windows environment, including outside the sandbox. Re-evaluate this fallback when updating Next.js. ESLint 9.39.5 is retained because the plugins bundled by `eslint-config-next` do not yet declare support for ESLint 10; npm currently marks ESLint 9 as unsupported. Upgrade the lint toolchain together when plugin compatibility is available.

## Project structure

```text
src/
├── app/
│   ├── (auth)/             # Reserved route group
│   ├── (dashboard)/        # Reserved route group
│   ├── api/                # Reserved for future route handlers
│   ├── globals.css         # Tailwind theme and global defaults
│   ├── layout.tsx          # Root layout and metadata
│   └── page.tsx            # Temporary initialization screen
├── components/
│   ├── ui/                 # Reusable UI primitives
│   ├── layout/             # Shared layout components
│   └── shared/             # Cross-feature components
├── features/               # Feature-owned code, introduced as needed
├── lib/
│   ├── supabase/           # Reserved; no client initialized
│   ├── utils/
│   │   └── cn.ts           # Conditional Tailwind class merging
│   └── constants/
├── hooks/
├── types/
└── config/
```

Reserved directories contain only `.gitkeep` so Git preserves the requested structure. They do not register routes or implement features. Add files as each feature is developed; remove its placeholder when adding real content.

## Design system

`src/app/globals.css` defines Tailwind v4 `@theme` variables. Use semantic utilities such as `bg-background`, `bg-surface`, `text-text-primary`, `text-text-secondary`, `border-border`, `bg-primary`, and `hover:bg-primary-hover`.

| Token | Value |
| --- | --- |
| Primary / hover | `#2563EB` / `#1D4ED8` |
| Background / surface | `#F8FAFC` / `#FFFFFF` |
| Primary / secondary text | `#172033` / `#64748B` |
| Border | `#E2E8F0` |
| Success | `#0D9488` |
| Warning | `#D97706` |
| Danger | `#DC2626` |

The theme uses a system font stack, a 4px spacing unit, shared corner radii, and a subtle small shadow. Global defaults provide light colors, readable line height, and visible keyboard focus. Standard Tailwind responsive breakpoints remain available. No font downloads or component framework are required.

Use the shared class helper when combining conditional or overridable classes:

```tsx
import { cn } from "@/lib/utils/cn";

const className = cn("text-text-primary", isMuted && "text-text-secondary");
```

## Development conventions

- Keep this stage limited to foundation work. Add authentication, APIs, database schemas, roles, and business features only under a separate task.
- Keep pages and layouts as Server Components by default. Add `"use client"` only when browser behavior requires it.
- Put feature-specific code under `src/features`; promote shared code into `components`, `hooks`, or `lib` when needed.
- Use PascalCase component names, camelCase functions, and descriptive kebab-case filenames. Follow App Router filenames for routes.
- Use `@/` for source imports and `import type` for type-only dependencies.
- Prefer semantic design tokens, accessible HTML, and responsive Tailwind utilities over scattered values.
- Use `cn` for conditional class composition; do not add a UI framework without a concrete requirement.
- Use pnpm exclusively and commit `package.json` with `pnpm-lock.yaml` after dependency changes.
- For Antigravity, Codex, and Claude handoffs, inspect existing work first, keep changes scoped, and report lint, type checking, and build results. Do not commit credentials or generated build output.
