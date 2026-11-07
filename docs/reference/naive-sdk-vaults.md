> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# vaults

> Write-only credentials — client.vaults and client.vaults.credentials.

A vault holds credentials that are injected at the network boundary and **never revealed**. Seven methods, and no read of a secret anywhere. API detail: [Vaults](https://vetta.sh/docs/api/vaults.md).

> [!WARNING]
>
> **There is no reveal method, and that is the contract, not an omission.** The control plane serves no reveal route and the credential schema has no `value` field, so `credentials.list` could not return one even if a handler tried.

## create

```ts theme={"system"}
client.vaults.create(body: VaultCreate): Promise<Vault>
```

`POST /v1/vaults`. `VaultCreate` is `{ display_name, identity_id? }` — bind the vault to one persona (its `idn_` id or its name) or leave it org-wide. An `identity_id` that is not an identity in your organization answers `404 not_found`.

## list

```ts theme={"system"}
client.vaults.list(query?: ListQuery): Promise<Page<Vault>>
```

`GET /v1/vaults`, cursor-paginated.

## get

```ts theme={"system"}
client.vaults.get(id: string): Promise<Vault>
```

`GET /v1/vaults/{id}`.

## delete

```ts theme={"system"}
client.vaults.delete(id: string): Promise<Deleted>
```

`DELETE /v1/vaults/{id}`. Soft-deletes the vault; its credentials go for real. **Irreversible for the secrets.**

## credentials.create

```ts theme={"system"}
client.vaults.credentials.create(vaultId: string, body: CredentialCreate): Promise<VaultCredential>
```

`POST /v1/vaults/{id}/credentials` — the only call in the system that carries a secret. `value` travels once, on this call, and is sealed server-side; the response is metadata only.

```ts theme={"system"}
const vault = await client.vaults.create({ display_name: "Task tracker access" });
const credential = await client.vaults.credentials.create(vault.id, {
  kind: "static_bearer",
  key: "Task tracker API key",
  value: process.env.TASK_TRACKER_TOKEN!,
  mcp_server_url: "https://mcp.example.com/mcp",
});
```

**kind** `VaultCredentialKind` *required*

`static_bearer` or `mcp_oauth`. `env_var` is part of the type but **not available**: it is refused with `501 feature_not_configured` and nothing is stored.

**key** `string` *required*

A display label for the credential.

**value** `string` *required*

The secret. Write-only.

**mcp\_server\_url** `string`

Required for the two MCP kinds: the exact server URL the token is injected into.

**host** `string`

Only read for `env_var`, which is not available.

**agent\_id** `string`

The one agent the token may be injected into. Omitted, any agent that declares the URL.

**expires\_at** `string`

Optional expiry, an RFC 3339 timestamp in the future. A past one is refused with `400 validation_failed`.

## credentials.list

```ts theme={"system"}
client.vaults.credentials.list(vaultId: string, query?: ListQuery): Promise<Page<VaultCredential>>
```

`GET /v1/vaults/{id}/credentials`. Metadata only — `key`, `kind`, `last_injected_at`; never a value.

## credentials.delete

```ts theme={"system"}
client.vaults.credentials.delete(vaultId: string, credentialId: string): Promise<Deleted>
```

`DELETE /v1/vaults/{id}/credentials/{credential_id}`.

**Rotation is create-new + delete-old.** There is no `update`, so `last_injected_at` stays attributable to exactly one secret.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.