# Pins for the Tandem kit (TDM-184 [16.13] phase 1, 2026-11-07)

What `kits/tandem-vs-claude-code` pins, and where each value came from.

## Tandem ref

```sh
git ls-remote https://github.com/jaximus808/tandem refs/heads/main 'refs/tags/*'
```

```
05b4a022651f4823dbe00e2748df5862d9c32164	refs/heads/main
fd8f45babb3d928a46d8ff80b63b2e9df96e5868	refs/tags/mcp-v3.0.1
8d56127caaee833c8de88dcccecef9edbbf9b100	refs/tags/mcp-v3.1.0
05b4a022651f4823dbe00e2748df5862d9c32164	refs/tags/mcp-v3.2.0
50a792f287518e2950c07311c41e0470f4ef4ec4	refs/tags/v0.1.0
ee1f966cc94801e0963674d40f6a30b740677939	refs/tags/v0.1.1
05b4a022651f4823dbe00e2748df5862d9c32164	refs/tags/v0.2.0
```

`main`, `v0.2.0` and `mcp-v3.2.0` are the same commit. The kit pins `ref:
05b4a022651f4823dbe00e2748df5862d9c32164` and `TANDEM_MCP_VERSION: 3.2.0`.

## npm versions

```sh
npm view @jaximus/tandem-mcp version dist-tags --json
npm view @anthropic-ai/claude-code dist-tags --json
```

```
{ "version": "3.2.0", "dist-tags": { "latest": "3.2.0" } }
{ "stable": "2.1.311", "latest": "2.1.319", "next": "2.1.319" }
```

The first phase-1 commit pinned Claude Code `2.1.311` (the `stable` dist-tag). After the founder's
Naïve-proxy decision the kit pins `2.1.319`, the version verified on the proxy
(TDM-16, `docs/findings/claude-code-naive-proxy.md`); its binary is where
`CLAUDE_CODE_MODEL_CAPABILITIES` was found.

## Model id

TDM-178's `isPinnedModelId` accepts a `claude-*` id only when it ends in a date (`-YYYYMMDD`).
The Claude models list (claude-api skill `shared/models.md`, cached 2026-10-06) shows that only
older models have dated ids. Every model from 4.6 on (`claude-opus-4-6` … `claude-opus-5-5`,
`claude-sonnet-5-5`, `claude-haiku-5-5`) has no dated id: the bare id is already the snapshot.

| Model | Dated id | Status |
| --- | --- | --- |
| Claude Opus 4.5 | `claude-opus-4-5-20251101` | Active (legacy) |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | Active |
| Claude Sonnet 4.5 | `claude-sonnet-4-5-20250929` | Deprecated, retires 2026-11-30 |

## Model id on the Naïve proxy (what the kit pins)

After the founder's decision that every contender runs through the Naïve model proxy, the kit pins
`anthropic/claude-sonnet-4.6`, a Naïve id (the proxy refuses Anthropic ids such as
`claude-sonnet-4-6`). `isPinnedModelId` accepts it as is: the dated-suffix rule applies only to
ids that start with `claude-`, `gpt-` or `o<digit>`, and a provider-prefixed id passes when it is
not an alias (`~anthropic/claude-sonnet-latest` is refused by the `-latest` rule) and has a digit.

```sh
node -e 'import("./packages/kit/dist/index.js").then(async (k) => { const r = await k.validateKitDir("kits/tandem-vs-claude-code"); console.log(r.ok, r.errors.length, r.warnings.map((w) => w.code)); })'
```

```
true 0 [ 'unused_dir' ]
```

The one warning is followup 23 (the shared `adapters/claude-code/` folder has no contender of that
id).
