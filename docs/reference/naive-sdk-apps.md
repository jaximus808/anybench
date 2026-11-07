> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# apps

> Hosted web applications — client.apps.

An app is **org-level**: it belongs to the organization, not to an agent, and outlives any session. Thirty-five methods: twenty on an app itself, plus `installs.apply` / `installs.list` / `installs.update` / `installs.context` / `installs.remove` / `installs.preview` for the declaration a project is applied from and what its crew knows, `artifacts.list` for the catalog it is applied out of, `companyTemplates.draft` / `companyTemplates.create` / `companyTemplates.list` for a company saved as a private template, `listings.list` / `listings.checks` for the company's marketplace listings and what a new one would send, `profile.get` / `profile.update` for the public profile its listings credit, and `earnings.setUpPayouts` for where its earnings are paid. API detail: [Apps](https://vetta.sh/docs/api/apps.md).

## create

```ts theme={"system"}
client.apps.create(body: AppCreate): Promise<App>
```

`POST /v1/apps`. `AppCreate` is `{ name, description?, type?, mcp? }` — `type` is `"frontend_only"` (default) or `"fullstack"`; `mcp` is the path of the MCP endpoint a `fullstack` app serves (`"/mcp"`), refused on `frontend_only`. Idempotent on the name.

## list

```ts theme={"system"}
client.apps.list(query?: ListQuery): Promise<Page<App>>
```

`GET /v1/apps`, cursor-paginated.

## get

```ts theme={"system"}
client.apps.get(id: string): Promise<App>
```

`GET /v1/apps/{id}`. A `fullstack` app's backend advances on read — poll here until `status` is terminal.

## update

```ts theme={"system"}
client.apps.update(id: string, body: AppPatch): Promise<App>
```

`PATCH /v1/apps/{id}`. `AppPatch` is `{ description?: string | null, mcp?: string | null }`. Setting `mcp` mints the app's `VETTA_MCP_TOKEN` secret and connects every agent that can access the app to its tools as `<app>.<tool>`; `null` removes both. See [Tools from your apps](https://vetta.sh/docs/capabilities/tools.md#tools-from-your-apps).

## delete

```ts theme={"system"}
client.apps.delete(id: string): Promise<Deleted>
```

`DELETE /v1/apps/{id}`. Tears down the hosting project and, for `fullstack`, the app database. Irreversible.

## deploy

```ts theme={"system"}
client.apps.deploy(id: string, files: Record<string, string>, content_hash?: string): Promise<AppDeployment>
```

`POST /v1/apps/{id}/deployments`. `files` maps paths to base64 contents; the build runs asynchronously. `content_hash` is an opaque digest of `files` you compute (up to 128 characters). The platform stores it as sent, never checks it, and echoes it on every deployment read, so you can compare it against the newest deployment and skip uploading an unchanged site.

## redeploy

```ts theme={"system"}
client.apps.redeploy(id: string, fromDeployment: string): Promise<AppDeployment>
```

`POST /v1/apps/{id}/deployments` with `{ from_deployment }`. Ships one of the app's earlier deployments again, as a new deployment, from the files the platform kept — nothing is uploaded, so a site of any deployable size comes back. Poll [`deployments`](#deployments) as for `deploy`.

## deploymentFiles

```ts theme={"system"}
client.apps.deploymentFiles(id: string, deploymentId: string): Promise<AppDeploymentFiles>
```

`GET /v1/apps/{id}/deployments/{deployment_id}/files`. The file map a deployment shipped: `{ object: "app_deployment_files", deployment_id, files }`, path → base64. `not_found` for a build made before files were kept.

## deployments

```ts theme={"system"}
client.apps.deployments(id: string, query?: { limit?: number }): Promise<Page<AppDeployment>>
```

`GET /v1/apps/{id}/deployments`. Non-terminal builds advance on read.

## setSecret

```ts theme={"system"}
client.apps.setSecret(id: string, body: { name: string; value: string }): Promise<AppSecret>
```

`POST /v1/apps/{id}/secrets`. Write-only: the value never comes back on any read. Overwrites an existing name. The names the platform manages itself — a `fullstack` app's `DATABASE_*` variables and `VETTA_MCP_TOKEN` (set through [`update`](#update)'s `mcp`) — are refused `forbidden`.

## secrets

```ts theme={"system"}
client.apps.secrets(id: string): Promise<{ object: "list"; data: AppSecret[] }>
```

`GET /v1/apps/{id}/secrets` — names and timestamps only, never values.

## deleteSecret

```ts theme={"system"}
client.apps.deleteSecret(id: string, name: string): Promise<{ object: "app_secret"; name: string; deleted: boolean }>
```

`DELETE /v1/apps/{id}/secrets/{name}`. A platform-managed name (see [`setSecret`](#setsecret)) is refused `forbidden`.

## connectDomain

```ts theme={"system"}
client.apps.connectDomain(id: string, domainId: string): Promise<AppDomain>
```

`POST /v1/apps/{id}/domains`. The domain must already exist at [`client.domains`](https://vetta.sh/docs/sdk/domains); connecting is pointing, never registering.

## domains

```ts theme={"system"}
client.apps.domains(id: string): Promise<{ object: "list"; data: AppDomain[] }>
```

`GET /v1/apps/{id}/domains`.

## disconnectDomain

```ts theme={"system"}
client.apps.disconnectDomain(id: string, domain: string): Promise<{ object: "app_domain"; domain: string; deleted: boolean }>
```

`DELETE /v1/apps/{id}/domains/{domain}` — by domain name.

## entry

```ts theme={"system"}
client.apps.entry(id: string): Promise<{ object: "app_entry"; url: string; ticket: string }>
```

`POST /v1/apps/{id}/entry`. A one-click way into an app whose operator gate the platform generated. Answers a `ticket` valid for two minutes, never the app's token: POST it to `url` as a form field from the operator's browser, and never put it in a query string.

## permissions

```ts theme={"system"}
client.apps.permissions(id: string): Promise<{ object: "app_permissions"; app_id: string; scopes: string[] }>
```

`GET /v1/apps/{id}/permissions`. What the app's own key may do: its scopes, never the key.

## access

```ts theme={"system"}
client.apps.access(id: string): Promise<{ object: "app_access"; url: string | null; password: string | null }>
```

`GET /v1/apps/{id}/access`. How a person gets into the app without the Studio: its URL and its generated `DASHBOARD_PASSWORD` — `null` until one is provisioned. An audited reveal; hand the value to a person, never put it in a URL or a log.

## rotateAccess

```ts theme={"system"}
client.apps.rotateAccess(id: string): Promise<{ object: "app_access"; url: string | null; password: string | null }>
```

`POST /v1/apps/{id}/access`. Regenerates the password **and** the `DASHBOARD_TOKEN`, and answers the new password. Rotating is revoking: every browser already signed in is signed out.

## query

```ts theme={"system"}
client.apps.query(id: string, query: string): Promise<{ object: "app_db_result"; rows: unknown[]; row_count: number }>
```

`POST /v1/apps/{id}/db/query`. `fullstack` apps only; a `frontend_only` app answers `feature_not_configured`. The database as a whole — tables, a REST facade over them, migrations, and this same query without naming the app — is [`client.database`](https://vetta.sh/docs/sdk/database).

## installs.apply

```ts theme={"system"}
client.apps.installs.apply(body: InstallApply): Promise<BlueprintInstall>
```

`POST /v1/blueprints/installs`. Records one applied declaration for a project — with what, by whom, and against which revision — and, when you name a published pair instead of sending one, performs the apply too.

Sending a `declaration` records only, and that is the right shape for this client: you reconciled it yourself, which is the upsert-by-name every other method here performs, so `report` comes back `null`. Omitting the declaration and naming a published `blueprint` and `template` asks the server to reconcile the catalog's bytes for you, as you, and `report` is what that run did — one line per resource, refusals included.

`expected_revision` is [`expected_version`](https://vetta.sh/docs/api/agents) copied: omit it for a deliberate unconditional apply, or send the revision you believe you are moving from and a mismatch is refused `revision_conflict`, whose message names the paths at which the stored declaration and yours disagree. Send `0` to create: a project that already exists is refused rather than re-applied.

`selection: { agents: string[]; apps: string[] }` names which of the template's crew this apply provisions; omit it and the whole crew is. A deselected agent is not created, its schedules are not armed and its intake does not open; one that already exists is left running, and the report names it under `deselected` — apart from `skipped`, because a choice is not a failure. A selection that leaves out a `required` agent or app is refused `validation_failed`, naming every missing one. The install stores the `selection` it was applied with (`null` for everything, and for every install written before the field existed). See [Templates](https://vetta.sh/docs/concepts/templates.md).

## installs.list

```ts theme={"system"}
client.apps.installs.list(query?: { project?: string; limit?: number; after?: string }): Promise<Page<BlueprintInstall>>
```

`GET /v1/blueprints/installs`. Every install in the organization, most recently applied first; `project` narrows it to one project's.

## installs.update

```ts theme={"system"}
client.apps.installs.update(id: string, body: { answers: Record<string, unknown> }): Promise<BlueprintInstall>
```

`PATCH /v1/blueprints/installs/{id}`. Rewrites the setup answers of an applied install — the whole map, not a merge, so send every answer you mean to keep. Each key must be a question the install's artifact declares, and each value a string or a list of strings; anything else is refused `validation_failed`. The install's `context_updated_at` moves and its `revision` does not: an answer edit is not an apply, re-provisions nothing and briefs no agent again. The crew reads the new answer through [`installs.context`](#installscontext) the next time it looks.

## installs.context

```ts theme={"system"}
client.apps.installs.context(id: string): Promise<ProjectContext>
```

`GET /v1/blueprints/installs/{id}/context`. What the crew of this install knows about the business: `{ object: "project_context", project, blueprint, template, artifact_version, answers: { key, label, value }[], apps: { name, url }[], agents: { name, role }[], updated_at }`, derived from the install and its report — the answers as the artifact's questions label them, the apps with the URL each is served at, the agents with the role each was declared with. It is the same object a template agent reads through its built-in `project_context` tool.

## installs.remove

```ts theme={"system"}
client.apps.installs.remove(id: string): Promise<{ id: string; object: string; deleted: boolean }>
```

`DELETE /v1/blueprints/installs/{id}`. Takes a template out of the company: its agents are fired (their timers stop, their open cards lose their name), its unfinished board tasks and its mini apps go, and the install is deleted. Its apps, personas, skills, files and chats stay. Nothing is refunded or charged. Only the owner's own sign-in may call it; an API key is refused `forbidden`. A second call is `not_found`.

## installs.preview

```ts theme={"system"}
client.apps.installs.preview(query: { blueprint: string; template: string; project: string }): Promise<InstallPreview>
```

`GET /v1/blueprints/preview`. What applying a published pair as a new project would call its agents, apps and personas here: `{ object: "install_preview", project, blueprint, template, artifact_version, name_prefix, agents, apps, identities }`. `name_prefix` is `"<project>-"` when any declared name is already taken in the organization, and every name then carries it. Writes nothing.

## artifacts.list

```ts theme={"system"}
client.apps.artifacts.list(query?: {
  blueprint?: string; template?: string; limit?: number; after?: string;
}): Promise<Page<BlueprintArtifact> & { skipped: number }>
```

`GET /v1/blueprints/artifacts`. The published catalog, newest release first — every blueprint × template that can be run, carrying the setup questions to ask first, the crew and the apps it provisions, and the timers it runs.

The catalog belongs to no organization: it is the same list for everybody, and nothing a customer writes reaches it. Applying one of these rows sends its `blueprint` and `template` in place of a `declaration`, which the catalog holds server-side.

## companyTemplates.draft

```ts theme={"system"}
client.apps.companyTemplates.draft(body?: { project?: string }): Promise<CompanyTemplateDraft>
```

`POST /v1/company_templates/draft`. "Duplicate this company": exports the crew and rewrites its company specifics into a draft declaration. A metered model call.

## companyTemplates.create

```ts theme={"system"}
client.apps.companyTemplates.create(body: { name: string; project?: string; declaration: CompanyTemplateDraft["declaration"] }): Promise<BlueprintArtifact>
```

`POST /v1/company_templates`. Saves a draft a person approved as a **private** template of this organization. Install it with `installs.apply({ blueprint, template, project, expected_revision: 0 })`; no other organization can.

## companyTemplates.list

```ts theme={"system"}
client.apps.companyTemplates.list(query?: { template?: string; limit?: number; after?: string }): Promise<Page<BlueprintArtifact> & { skipped: number }>
```

`GET /v1/company_templates`. This organization's private templates, as catalog rows.

## listings.checks

```ts theme={"system"}
client.apps.listings.checks(query?: { project?: string }): Promise<ListingChecks>
```

`GET /v1/listings/checks`. What listing the company in the marketplace would send — the changes made, anything refused, and every word that would be listed. Read only: a listing is posted from chat, not from the SDK.

## listings.list

```ts theme={"system"}
client.apps.listings.list(): Promise<OwnListings>
```

`GET /v1/listings`. The company's own marketplace listings, newest first, each with its review `status` and whether it was `taken_down`. `balance_micro_usd` is what they earned and not yet paid out, and `ready_micro_usd` the part a payout would send now; both are `null` for a key without `billing:read`.

## profile.get

```ts theme={"system"}
client.apps.profile.get(): Promise<CreatorProfile>
```

`GET /v1/listings/profile`. The company's public profile, which its listed templates credit: `handle`, `name`, `description`, `avatar_url` and `verified`.

## profile.update

```ts theme={"system"}
client.apps.profile.update(body: {
  name?: string;
  description?: string;
  avatar?: { content_type: "image/png" | "image/jpeg" | "image/webp"; data: string } | null;
}): Promise<CreatorProfile>
```

`PATCH /v1/listings/profile`. `name` is 1–60 characters and `description` at most 280. `avatar` is a base64 picture of at most 512 KiB, and `null` removes it. Only a signed-in owner or admin may update the profile; anyone else, an API key included, is `forbidden`.

## earnings.setUpPayouts

```ts theme={"system"}
client.apps.earnings.setUpPayouts(body?: { country?: string }): Promise<{ object: "earnings_payout_account"; ready: boolean; onboarding_url: string | null }>
```

`POST /v1/earnings/payouts/account`. Where the company's marketplace earnings are paid. The owner, signed in, opens `onboarding_url` until `ready` is `true`.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.