# Vercel: deploying apps/web (preview)

Date: 2026-11-07. CLI: Vercel CLI 65.12.1, logged in as `jaximus808`.
Scope: personal Hobby team `jaximus808s-projects` ("jaximus808's projects"). Project: `anybench` (`prj_xyPjMLcP1rEoOIXLbk3JO6qogGFN`).
Deployed from the worktree `anybench-wt/TDM-99` at commit `47c0f91`.

## Working project settings

| Setting | Value |
|---|---|
| Framework | `nextjs` |
| Root Directory | `apps/web` |
| Include files outside root directory | on (`sourceFilesOutsideRootDirectory: true`) |
| Install command | `pnpm install --frozen-lockfile` (runs in apps/web; pnpm installs the whole workspace) |
| Build command | `pnpm --filter @anybench/core build && pnpm run build` |
| Output directory | default |
| Node.js | `22.x` (new projects default to 26.x; set to match `.nvmrc`) |
| Env | `ENABLE_EXPERIMENTAL_COREPACK=1`, plain, all targets. Vercel then used `pnpm v11.2.2` from `packageManager`. |
| `NEXT_PUBLIC_ANYBENCH_WEB_URL` | unset (the app falls back to https://anybench.jaxonp.com) |

The remote build worked on the first try: install took 17s, `tsc` for core then `next build` (Turbopack), 37s in total. The routes are `/`, `/_not-found` and `/icon.svg`, all static.

## Commands

Run these from the repo or worktree root, not from apps/web:

```sh
vercel project add anybench --scope jaximus808s-projects
vercel link --yes --project anybench --scope jaximus808s-projects
# Gotcha: `link` appends `.vercel` and `.env*` to .gitignore and writes .env.local (OIDC token).
# .gitignore already covers both, so revert the edit: git checkout -- .gitignore && rm .env.local
vercel api /v9/projects/anybench --scope jaximus808s-projects -X PATCH --input proj.json
#   proj.json: {"framework":"nextjs","rootDirectory":"apps/web","sourceFilesOutsideRootDirectory":true,
#               "installCommand":"pnpm install --frozen-lockfile",
#               "buildCommand":"pnpm --filter @anybench/core build && pnpm run build"}
vercel api /v9/projects/anybench --scope jaximus808s-projects -X PATCH -f nodeVersion=22.x
vercel api /v10/projects/anybench/env --scope jaximus808s-projects -X POST --input env.json
#   env.json: {"key":"ENABLE_EXPERIMENTAL_COREPACK","value":"1","type":"plain","target":["production","preview","development"]}
vercel deploy --yes --target preview --scope jaximus808s-projects --logs
```

`vercel env add NAME <env>` with a value piped on stdin made messy entries: an "encrypted" one for development and "sensitive" ones for preview/production that we couldn't check. Use the REST call above instead.

An untracked `.vercelignore` at the root keeps `.env*`, `.tandem`, `.gstack`, `node_modules`, `.next`, `dist` and `*.tsbuildinfo` out of the upload. The CLI's default ignore list does not include `.env`.

## Gotchas

- **The first deployment of a new project goes to production**, even without `--prod`. The CLI said: "This is the project's first deployment, so it was assigned to production." That first deploy (`dpl_8hoocSDhzHcerjC1kMUDwXN8TsqG`) was aliased to https://anybench.vercel.app. Pass `--target preview` explicitly every time, and to keep a project preview-only, make the first deploy something you're happy to have in production.
- Deployment Protection defaults to Standard (`ssoProtection.deploymentType = all_except_custom_domains`). A public `curl` of the preview URL returns `302` to `https://vercel.com/sso-api?...`, so viewers need a Vercel login with access to the scope. But the production alias `anybench.vercel.app` returned **200 to an unauthenticated curl**.
- To check a protected deployment, run `vercel curl <url> --scope jaximus808s-projects -- -s -o out.html -w '%{http_code}'`. It printed `200`, and the HTML title was `Anybench: find out if what you built is actually better`.
- In this CLI version, `vercel api` output piped straight into another program came through empty. Redirect it to a file first.
