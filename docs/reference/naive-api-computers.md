> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Computers

> Sandboxed compute environments with a browser and filesystem.

A **computer** is a durable, sandboxed environment an [agent](https://vetta.sh/docs/api/agents.md) can use: a shell, a filesystem, and an optional browser constrained to an allowlist of domains. Computers can be paused to stop compute charges and snapshotted for fast restore.

A [session](https://vetta.sh/docs/api/sessions.md) whose toolset needs a filesystem works on its agent's computer, started the first time one is needed, and reports it as `computer_id`. An agent's computer appears in this list named `agent {id}`, with `agent_id` set, so you can tell it from the ones you created; it belongs to the agent, not to any one session (see [An agent's computer](#an-agents-computer)). A session started before agents had their own computer may still hold one it provisioned for itself, named `session {id}`, until it ends.

## The computer object

**id** `string`

Unique id (e.g. `cmp_01H...`).

**object** `string`

Always `computer`.

**name** `string`

Human-readable name.

**vcpu** `integer`

Provisioned vCPU for a micro-VM (1–16).

**memory\_mb** `integer`

Provisioned memory in MiB (128–65536).

**disk\_gb** `integer`

Root disk size in GiB.

**status** `string`

Lifecycle state — see [below](#lifecycle).

**browser** `object`

Browser configuration, or `null` if disabled. Every field has a default, so `{}` alone is a complete option and the browser reaches the open web. Drive it through the [Browser](https://vetta.sh/docs/api/browser.md) routes.

**browser**

**allowed\_domains** `string[]`

Domain allowlist (supports wildcards, e.g. `*.example.com`). Defaults to `["*"]`; an explicit `[]` is refused.

**timeout\_minutes** `integer`

Session lifetime, 1–360. Default `15`.

**region** `string`

`us-west` (default), `us-east`, `eu-central` or `ap-southeast`.

**keep\_alive** `boolean`

Keep the session open across idle periods. Default `false`.

**viewport** `object`

`{ width, height }` in pixels.

**os** `string`

`windows`, `mac`, `linux`, `mobile` or `tablet` — the device the browser presents as.

**block\_ads** `boolean`

Default `false`.

**solve\_captchas** `boolean`

Default `true`.

**stealth** `boolean`

Default `false`.

**allow\_writes** `boolean`

Permit actions that change a page (submit, buy, delete, …). Default `false`.

**allow\_extract** `boolean`

Permit reads from a browser that holds a saved login. Default `false`.

**context\_name** `string`

Open on a saved login of that name (see [Browser](https://vetta.sh/docs/api/browser.md#save-a-login)).

**persist\_context** `boolean`

Write the login state back to that context at close. Default `false`.

**human\_login** `boolean`

Hold the context for a person to sign in through the live view; locks it for 15 minutes. Default `false`.

**proxy** `boolean`

Route through a residential proxy. Needs a bounded allow-list, not `*`. Default `false`.

**volume** `object | null`

Attached persistent volume. Always `null` — a volume separate from the boot disk is not provisioned today; size the root disk with `disk_gb`.

**snapshot\_id** `string | null`

Snapshot this computer was restored from, if any.

**agent\_id** `string | null`

The [agent](https://vetta.sh/docs/api/agents.md) this computer belongs to (see [An agent's computer](#an-agents-computer)), or `null` for one you created.

**created\_at** `string`

Creation timestamp.

## Lifecycle

| Status | Meaning |
| - | - |
| `creating` | Provisioning; not yet usable. |
| `running` | Ready and billable for compute: a computer you create is billed in 10-minute blocks at its size, in advance, and paused when your balance cannot cover the next block. |
| `paused` | Stopped; bills nothing, and the disk is kept. Resume to use again. Pausing a computer you created does not refund the rest of its 10-minute block already paid, and any exec, fs, snapshot or execStream call on a paused computer resumes it, so billing restarts. |
| `failed` | Provisioning failed; the computer never became usable. Terminal. |
| `destroyed` | Permanently deleted. Terminal. |

## Create a computer

`POST /v1/computers` → `202 Accepted`. Provisioning is asynchronous: the response returns immediately with `status: "creating"`. **Wait for readiness before using the computer**: poll `GET /v1/computers/{id}` until `status` is `running`. There is no computer lifecycle [event](https://vetta.sh/docs/api/events.md) to subscribe to — the event stream is session-scoped. If provisioning fails the computer moves to `failed`, and calls that need a live machine return `409` with code `computer_unavailable`.

Creating (or resuming) a computer needs a balance of at least 10 minutes of it; otherwise the call is `402` with code `insufficient_credits`. The 10-minute block a new computer starts in is charged when it is created.

**name** `string`

Human-readable name. Defaults to `computer`.

**vcpu** `integer`

Provisioned vCPU. Defaults to `2`.

**memory\_mb** `integer`

Provisioned memory in MiB. Defaults to `4096`.

**disk\_gb** `integer`

Root disk size in GiB. Defaults to `5`.

**browser** `object | null`

Browser config — `{}` enables one on the open web, `{ "allowed_domains": ["*.example.com"] }` scopes it; the full option object is [above](#the-computer-object). Defaults to `null`, which disables the browser.

**snapshot\_id** `string`

Snapshot (`snp_…`) to restore this computer from. The field is `snapshot_id`, not `snapshot`; an id that is not your organization's is `404`.

```bash cURL theme={"system"}
curl -fsSL https://api.vetta.sh/v1/computers \
  -H "authorization: Bearer sk_live_..." \
  -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{ "name": "box", "vcpu": 4, "memory_mb": 8192, "disk_gb": 40, "browser": { "allowed_domains": ["*.example.com"] } }'
```

```json Response theme={"system"}
{
  "id": "cmp_01H8YZ...",
  "object": "computer",
  "name": "box",
  "vcpu": 4,
  "memory_mb": 8192,
  "disk_gb": 40,
  "status": "creating",
  "browser": {
    "allowed_domains": ["*.example.com"],
    "timeout_minutes": 15,
    "region": "us-west",
    "keep_alive": false,
    "block_ads": false,
    "solve_captchas": true,
    "stealth": false,
    "allow_writes": false,
    "allow_extract": false,
    "persist_context": false,
    "human_login": false,
    "proxy": false
  },
  "volume": null,
  "snapshot_id": null,
  "agent_id": null,
  "created_at": "2026-08-20T17:00:00Z"
}
```

## Retrieve & list

```bash theme={"system"}
GET /v1/computers/{id}     # retrieve one -> 200 (poll status here)
GET /v1/computers          # list (cursor-paginated) -> 200
```

See [Pagination](https://vetta.sh/docs/api/pagination.md) for list parameters.

## An agent's computer

```bash theme={"system"}
GET /v1/agents/{id}/computer   # the agent's computer, or null -> 200
```

Each agent has one computer, and every session of the agent works on it and sees the same files. The answer is the agent's `computer`, or `null` before any session has needed one. The machine under it can change: the files are kept, and after a change this route names the new `cmp_` id. Another organization's agent is `404` `not_found`. It takes the same scope as `GET /v1/computers/{id}`.

The agent looks after its computer: it starts it when a session needs it, pauses it after a few idle minutes, and removes it when the agent is deleted. Your files are kept across all of that. So some calls on an agent's computer work differently:

| Call | On an agent's computer |
| - | - |
| `POST …/pause` | `409` `computer_unavailable` while a session or a person is using it. |
| `POST …/resume` | Wakes it. Nobody using it, it pauses again after 3 idle minutes. |
| `exec`, `fs/*`, `snapshot` | Wakes it if paused, and keeps it running until the call ends. |
| `POST …/takeover` | You hold it. The agent's sessions wait until you hand it back. Your time on it is not billed. `409` while a session is using it. |
| `DELETE …/takeover` | Hands it back. A takeover you do not hand back ends after an hour. |
| `DELETE /v1/computers/{id}` | `409` `computer_unavailable`: it goes when the agent goes. |

A call that names an older machine of the agent is `409` `computer_unavailable`; read the agent's computer for its current one. `takeover` on a computer you created is `409` too: nothing else uses it, so pause it instead.

## Rename

`PATCH /v1/computers/{id}` → `200 OK`. The name is the one field a computer has that you can change after creation; the body is strict, so any other field is `400` `validation_failed`. Returns the computer, and is recorded in the [audit log](https://vetta.sh/docs/api/audit-logs.md) as `computer.updated`.

**name** `string` *required*

1–200 characters.

## Inspect

`GET /v1/computers/{id}/inspect` → `200 OK`. What the computer is doing right now, from two sources: the provider's own record of it (`status`, `last_active_at`, and `home` — the directory the `fs/*` calls are rooted in, or `null` when the provider does not confine them), and — only when that record says `running` — a single probe command run inside the machine. Inspecting never wakes a paused computer, so a paused or stopped one always answers with `probe: null`. A probe that cannot run or cannot be parsed is also `probe: null`, never an error; the numbers are a sample taken at `sampled_at`, not a metrics feed.

This call requires the **`computers:write`** scope. Despite the verb, it is not a plain read: the probe runs a command inside your machine, on compute you are billed for. Use `GET /v1/computers/{id}` for a read that does not touch the machine.

The `home` in the example below is illustrative. **Read it from this call rather than hardcoding a path** — it is what the machine's image reports, and it can differ between computers.

```json Response theme={"system"}
{
  "object": "computer_inspect",
  "id": "cmp_01H8YZ...",
  "status": "running",
  "last_active_at": "2026-09-08T03:19:11Z",
  "home": "/home/naive",
  "probe": {
    "sampled_at": "2026-09-08T03:19:12Z",
    "uptime_seconds": 12345,
    "processes": 87,
    "load_1m": 0.42,
    "memory_used_mb": 1000,
    "memory_total_mb": 3952,
    "disk_used_gb": 1.0,
    "disk_total_gb": 5.0
  }
}
```

## Execute a command

`POST /v1/computers/{id}/exec` → `200 OK`. Runs a shell command and returns its output once it has finished. A `paused` computer is resumed first and stays `running` afterwards — pausing does not lock a computer; a `creating`, `failed`, or destroyed one returns `409` with code `computer_unavailable`. Every run — by this route or the streamed one below — is recorded in the computer's [command history](#command-history).

**command** `string` *required*

The command to run.

**timeout\_ms** `integer`

Max runtime, up to `600000`. Defaults to `30000`. When it elapses the command and every process it started (other than one detached with `setsid`) is killed, `exit_code` is `124` and `timed_out` is `true`.

`stdout` and `stderr` are each returned up to 262 144 characters; `truncated` is `true` when either was cut.

```bash theme={"system"}
curl -fsSL https://api.vetta.sh/v1/computers/cmp_01H8YZ.../exec \
  -H "authorization: Bearer sk_live_..." \
  -H "content-type: application/json" \
  -d '{ "command": "ls -a ~" }'
```

```json Response theme={"system"}
{ "exit_code": 0, "stdout": ".\n..\n.bashrc\n...", "stderr": "", "duration_ms": 42, "timed_out": false, "truncated": false }
```

### Stream a command

`POST /v1/computers/{id}/exec/stream` → `200 OK`, `text/event-stream`. The same run as `exec`, delivered as it happens: the body is a stream of Server-Sent Events whose `data:` lines are JSON frames — zero or more `{"stdout": "…"}` / `{"stderr": "…"}` chunks in the order the process produced them, then exactly one `exit` frame and the stream closes. `command_id` names the row the run was recorded as. Same body as `exec`; the same `404`/`409`/`400` refusals are returned as ordinary JSON errors before the stream opens. The SDK reads this as `computers.execStream(id, command, { timeoutMs })`, an async iterable of frames.

```text Response theme={"system"}
data: {"stdout":"compiling\n"}

data: {"stderr":"warning: unused\n"}

data: {"exit":{"exit_code":0,"timed_out":false,"truncated":false,"duration_ms":412,"command_id":"cmd_01J..."}}
```

## Build a 3D model

`POST /v1/computers/{id}/build-3d` → `200 OK` — scope `computers:write`. Runs a Python script that builds a model with [build123d](https://github.com/gumyr/build123d) (`cad`, millimetres) or Blender (`blender`, metres) in this computer, checks it, renders previews and publishes the exports as [files](https://vetta.sh/docs/api/files.md). The same program an agent's `build_3d` tool runs ([3D assets](https://vetta.sh/docs/capabilities/3d.md)). The toolchain (about 1.9 GB) installs into the computer on first use, so the first call needs 3 GB free disk: create the computer with `disk_gb` of 10 or more. A 5 GB computer has about 2.1 GB free and is refused with `409 computer_unavailable`. A paused computer is resumed first, as for `exec`.

**engine** `string` *required*

`cad`: the script assigns `result`, a build123d shape. `blender`: the script builds the scene with `bpy`.

**script** `string` *required*

The Python source, up to 200 KB.

**name** `string` *required*

Base name of the outputs, `[a-z0-9_-]{1,64}`.

**export** `string[]`

Any of `step`, `stl`, `3mf`, `glb`, `obj`, `blend`. Default `["step", "stl"]` for `cad`, `["glb"]` for `blender`.

**render** `object | false`

`{ views?: ("iso"|"front"|"top"|"side")[], size?: number }` — up to 4 views (default `["iso"]`), 256–1024 px (default 768). `false` renders nothing.

**publish** `boolean`

Default `true`. `false` runs the checks without publishing anything; the outputs are deleted from the computer when the call ends either way.

**timeout\_s** `integer`

Seconds the script and its exports may run, 10–300. Default 120. Rendering the previews has its own allowance on top (about 40–60 s per view, more for larger sizes), so previews never eat into the script's time.

```bash theme={"system"}
curl -fsSL https://api.vetta.sh/v1/computers/cmp_01H8YZ.../build-3d \
  -H "authorization: Bearer sk_live_..." \
  -H "content-type: application/json" \
  -d '{ "engine": "cad", "name": "plate", "script": "from build123d import *\nresult = Box(60, 40, 4) - Cylinder(3, 4)", "render": { "views": ["iso", "top"] } }'
```

```json Response theme={"system"}
{
  "ok": true,
  "files": [
    { "file_id": "fil_01J...", "name": "plate.step", "content_type": "model/step", "bytes": 21877 },
    { "file_id": "fil_01K...", "name": "plate.stl", "content_type": "model/stl", "bytes": 6884 }
  ],
  "previews": ["fil_01L...", "fil_01M..."],
  "checks": { "valid_solid": true, "watertight": true, "bbox_mm": [60, 40, 4], "volume_cm3": 9.49, "triangles": 136 },
  "error": null,
  "log_tail": "",
  "compute_seconds": 3.1
}
```

**ok** `boolean`

`false` when the script raised, a `cad` solid failed its checks, an STL or 3MF was withheld because the mesh is not watertight, or an output was over the file size limit (then nothing is published).

**files** `object[]`

The published exports. For `cad`, STEP, STL and 3MF are published only when `valid_solid` and `watertight` are both true. For either engine, STL and 3MF are never published from a mesh that is not watertight.

**previews** `string[]`

The rendered PNGs, as `fil_` ids.

**checks** `object | null`

`valid_solid` (`null` for `blender`), `watertight`, `bbox_mm``[x, y, z]`, `volume_cm3` (`null` when not closed), `triangles`. `null` when the script failed before producing a shape.

**error** `object | null`

`{ message, line }` — the script's own failure, with its line number when known. A failing script is a `200` with `ok: false`, not an error response.

**log\_tail** `string`

The last 4 KB of the build's log: everything the script and the toolchain printed.

**compute\_seconds** `number`

The computer time the build used.

There is no fee of its own: a build is billed as the computer's running seconds, like any other command. A `creating`, `failed`, or destroyed computer is `409` `computer_unavailable`; a body outside the limits above is `validation_failed`.

## Command history

`GET /v1/computers/{id}/commands` → `200 OK`. Every command run on the computer through `exec` or `exec/stream`, newest first, cursor-paginated ([Pagination](https://vetta.sh/docs/api/pagination.md)). Each row keeps the first 65 536 characters of `stdout` and of `stderr`; `truncated` is `true` when either was cut. `actor` is the principal that ran it — an API key, a user, or the platform acting for a session. Commands the agent runs *inside* a session through its own tools are not listed here; they are in the session's [event stream](https://vetta.sh/docs/api/events.md).

This read requires the **`computers:write`** scope — the same scope that runs a command. It hands back what those commands printed, so it is not readable by a credential that could not have produced it.

> [!NOTE]
>
> **Retention.** Command output is stored for **30 days** and then deleted; the rest of a computer's history is deleted with the computer. It is stored exactly as the command produced it — nothing scans or redacts it — so a command that prints a credential stores that credential for the window. Print secrets to a file, or read them from the [vault](https://vetta.sh/docs/identity/vault.md), rather than to stdout.

```json Response theme={"system"}
{
  "data": [
    {
      "id": "cmd_01J...",
      "object": "computer_command",
      "computer_id": "cmp_01H8YZ...",
      "command": "make",
      "exit_code": 0,
      "timed_out": false,
      "duration_ms": 412,
      "stdout": "compiling\n",
      "stderr": "",
      "truncated": false,
      "actor": { "type": "key", "id": "key_01J..." },
      "created_at": "2026-09-08T03:19:11Z"
    }
  ],
  "has_more": false,
  "next_cursor": null
}
```

## Pause & resume

Pausing stops compute charges while retaining state. Resuming makes it usable again. On an agent's computer both go through the agent; see [An agent's computer](#an-agents-computer).

```bash theme={"system"}
POST /v1/computers/{id}/pause    # -> 200, status: paused
POST /v1/computers/{id}/resume   # -> 200, status: running
```

```json Response theme={"system"}
{ "id": "cmp_01H8YZ...", "status": "paused" }
```

## Snapshot

`POST /v1/computers/{id}/snapshot` → `201 Created`. Captures the current filesystem state for fast restore. The body is empty — a snapshot has no name; its handle is the returned `snapshot_id`, which you pass as `snapshot_id` when creating a new computer. A snapshot outlives the computer it was taken from.

```bash theme={"system"}
curl -fsSL https://api.vetta.sh/v1/computers/cmp_01H8YZ.../snapshot \
  -H "authorization: Bearer sk_live_..."
```

```json Response theme={"system"}
{ "snapshot_id": "snp_0368aa449de84e308959ca72744a3bd5", "computer_id": "cmp_01H8YZ...", "created_at": "2026-08-20T18:00:00Z" }
```

### List snapshots

`GET /v1/snapshots` → `200 OK`. The organization's snapshots, newest first, [cursor-paginated](https://vetta.sh/docs/api/pagination.md) (`limit`, `after`); each item has the shape above.

### Delete a snapshot

`DELETE /v1/snapshots/{id}` → `200 OK` with `{ "id": "snp_…", "object": "snapshot", "deleted": true }`. Requires `computers:write`. Returns `409` with code `state_conflict` while a live computer was restored from it — destroy that computer first. A destroyed computer restored from it reads `snapshot_id: null` afterwards. An id that is not your organization's, or was already deleted, is `404`.

## Filesystem

The disk is reached through the governed `fs/*` operations — there is no separate upload/download channel. Each takes an absolute path. See [Filesystem](https://vetta.sh/docs/computer/filesystem.md) for limits and encoding details.

> [!WARNING]
>
> **The `fs/*` operations are confined to the computer's home directory** — the `home` that [inspect](#inspect) reports. A path outside it (`/`, `/etc`, `/var`, `/tmp`) is refused with `403 forbidden` by every `fs/*` call, `read`, `mkdir` and `remove` included. Use [exec](#execute-a-command) to look at the rest of the disk.

### Read a file

`POST /v1/computers/{id}/fs/read` → `200`

**path** `string` *required*

Absolute path of the file to read.

**encoding** `string`

`text` (default) or `base64`. Ask for `base64` when the file is not valid UTF-8 — decoding binary as text substitutes U+FFFD and loses bytes silently.

```json Response theme={"system"}
{ "path": "/home/naive/notes.txt", "encoding": "text", "content": "hello\n" }
```

### Write a file

`POST /v1/computers/{id}/fs/write` → `200`

**path** `string` *required*

Absolute path to write or overwrite.

**content** `string` *required*

The file contents, in the named encoding.

**encoding** `string`

`text` (default) or `base64` for binary payloads.

### List a directory

`POST /v1/computers/{id}/fs/list` → `200`

**path** `string` *required*

Absolute path of the directory; lists its immediate children.

Each entry carries the file's own metadata: `type` is `file`, `directory`, `symlink` or `other`; `mode` is the POSIX mode bits as an integer; `modified_at` is `null` when the filesystem does not report a time. The SDK returns the typed list as `computers.listDir(id, path)`.

### Create a directory

`POST /v1/computers/{id}/fs/mkdir` → `200`

**path** `string` *required*

Absolute path to create; parents are created too (`mkdir -p`).

### Remove a path

`POST /v1/computers/{id}/fs/remove` → `200`

**path** `string` *required*

Absolute path to remove; directories are removed recursively (`rm -rf`). `/`, the home directory and any folder that holds it are refused with `400 validation_failed` before anything runs.

```bash theme={"system"}
curl -fsSL https://api.vetta.sh/v1/computers/cmp_01H8YZ.../fs/list \
  -H "authorization: Bearer sk_live_..." \
  -H "content-type: application/json" \
  -d '{ "path": "/home/naive" }'
```

```json Response theme={"system"}
{
  "entries": [
    { "name": "report.md", "path": "/home/naive/report.md", "type": "file", "size_bytes": 9, "mode": 33188, "modified_at": "2026-09-08T03:19:11Z" },
    { "name": "src", "path": "/home/naive/src", "type": "directory", "size_bytes": 4096, "mode": 16877, "modified_at": "2026-09-08T03:18:40Z" }
  ]
}
```

> [!NOTE]
>
> To persist an artifact beyond the computer's lifetime, publish it to [Files](https://vetta.sh/docs/api/files.md) (Naive Managed Agents object storage) rather than leaving it on the computer's disk.

## Destroy

`DELETE /v1/computers/{id}` → `200 OK`. Permanently destroys the computer and its non-snapshotted disk.

```json Response theme={"system"}
{ "id": "cmp_01H8YZ...", "object": "computer", "deleted": true }
```

An agent's computer cannot be destroyed: the call is `computer_unavailable` (409). It is removed when the agent is deleted.

Ending or cancelling a session destroys nothing: its agent's computer, and the files on it, stay for
the agent's next session. Only a computer an older [session](https://vetta.sh/docs/api/sessions.md) provisioned for itself —
listed as `session {id}` — is tied to that session. It cannot be destroyed while the session can
still run a turn (the call is `computer_unavailable` (409) naming the session); it is destroyed with
the session, and one left resting at `idle` is reclaimed after an hour of silence.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.