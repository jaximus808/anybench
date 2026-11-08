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

The kit pins Claude Code `2.1.311`, the `stable` dist-tag on that day.

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

So the newest model the kit can pin today is `claude-opus-4-5-20251101`, and that is what it pins.
To benchmark on a current model, `UNDATED_MODEL_SNAPSHOTS` in `packages/kit/src/comparability.ts`
has to list the undated current ids (it is the extension point for undated snapshot ids).
