# apps/web

Next.js (App Router) site and app: landing, docs, legal, New run, Test plan, Live grid, Report, Scan, Company. Deploys to Vercel at https://anybench.jaxonp.com.

See plan.md, sections 3, 4 and E6/E11.

## Commands

```sh
pnpm --filter web dev        # http://localhost:3000
pnpm --filter web build      # next build (Turbopack)
pnpm --filter web typecheck  # tsc --noEmit (works without a prior build)
pnpm --filter web lint       # eslint
pnpm --filter web test       # vitest + jsdom + Testing Library
```

`@anybench/core` is consumed from its `dist/`, so run `pnpm -r build` (or `pnpm --filter @anybench/core build`) once before `dev`.

## Layout

- `app/layout.tsx`: fonts (next/font/google: Bricolage Grotesque, Source Serif 4, JetBrains Mono), Header, Footer.
- `app/globals.css`: the design tokens from `docs/design/anybench-product-page.html` as CSS variables, light and dark (`prefers-color-scheme`, overridable with `<html data-theme="light|dark">`):
  - colour: `--bg`, `--surface`, `--fg`, `--muted`, `--line`, `--line-strong`, `--accent`, `--accent-soft`, `--on-accent`, `--ok(-soft)`, `--warn(-soft)`, `--bad`, `--code-bg/fg/dim/acc/ok`
  - type: `--display` (Bricolage Grotesque), `--body` (Source Serif 4), `--mono` (JetBrains Mono); scale `--text-xs` 13 · `--text-sm` 15 · `--text-base` 17 · `--text-md` 21 · `--text-lg` 26 · `--text-xl` 26→33 · `--text-2xl` 34→52 · `--text-3xl` 40→78 (fluid); `--leading-tight/snug/body`, `--tracking-display`
  - spacing: `--space-1` … `--space-10` (4, 8, 12, 16, 24, 32, 48, 64, 96, 128 px)
  - layout: `--wrap` 1080px, `--column` 860px, `--measure` 66ch, `--gutter`, `--header-h`, `--radius-sm/md/lg`, `--ease-out`
  - utilities: `.wrap` (centred, padded container; pages own their width, the layout does not wrap `main`), `.column`, `.lede`, `.muted`, `.btn`, `.btn-quiet`, `.visually-hidden`
  Style new components with CSS modules that use these variables.
- `components/site/Header.tsx` (client: sticky translucent bar, mobile menu with Escape-to-close), `Footer.tsx`, `Mark.tsx`, and `nav.ts` (`NAV_LINKS`, `SIGN_IN_LINK`, `LEGAL_LINKS`). Signed-out state only so far.
- `app/(marketing)/page.tsx`: home page placeholder; [11.2] replaces it.
- `lib/api.ts`: `api()` / `createWebApiClient()` wrap `createApiClient` from `@anybench/core` with the cookie session (`credentials: "include"`). Base URL from `NEXT_PUBLIC_ANYBENCH_API_URL` (default `http://localhost:8787`).

## Env

- `NEXT_PUBLIC_ANYBENCH_API_URL`: API origin, inlined at build time (prod: `https://api.anybench.jaxonp.com`).
- `NEXT_PUBLIC_ANYBENCH_WEB_URL`: this site's origin, used for `metadataBase` (default `https://anybench.jaxonp.com`).

## Vercel (monorepo)

Create the Vercel project from this repo with:

- Framework preset: Next.js
- Root Directory: `apps/web` (enable "Include files outside the root directory in the Build Step", the default)
- Install Command: `pnpm install --frozen-lockfile` (Vercel runs it at the repo root because of `pnpm-workspace.yaml`; pnpm version comes from the root `packageManager` field)
- Build Command: `pnpm --filter @anybench/core build && next build` (core must be built because web imports its `dist/`)
- Output: default (`.next`)
- Env `ENABLE_EXPERIMENTAL_COREPACK=1` so Vercel uses the root `packageManager` pnpm (11.x) instead of its bundled pnpm
- Env: `NEXT_PUBLIC_ANYBENCH_API_URL=https://api.anybench.jaxonp.com`
- Domain: `anybench.jaxonp.com`

No `vercel.json` is needed.

## Not yet

- MSW mocks for every API route, Playwright and axe in CI: follow-ups (the original [11.1] done condition lists them; skipped for the fast first deploy).
- Signed-in header state: arrives with the auth UI.
