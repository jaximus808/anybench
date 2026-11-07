> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# computers

> Sandboxed machines — lifecycle, shell, filesystem, snapshots — client.computers.

A computer is a sandboxed machine a session works on. Objects parse with the core `ComputerSchema`. API detail: [Computers](https://vetta.sh/docs/api/computers.md).

## create

```ts theme={"system"}
client.computers.create(body: ComputerCreate): Promise<Computer>
```

`POST /v1/computers`. Every field is optional — an empty body gets the defaults.

**name** `string`

Display name.

**vcpu** `integer`

Virtual CPUs.

**memory\_mb** `integer`

Memory in MiB.

**disk\_gb** `integer`

Disk in GiB.

**browser** `object`

Browser policy, e.g. `{ allowed_domains: ["*.example.com"] }`.

**snapshot\_id** `string`

A `snp_` snapshot to restore from.

## list

```ts theme={"system"}
client.computers.list(query?: ListQuery): Promise<Page<Computer>>
```

`GET /v1/computers`, cursor-paginated.

## get

```ts theme={"system"}
client.computers.get(id: string): Promise<Computer>
```

`GET /v1/computers/{id}`.

## update

```ts theme={"system"}
client.computers.update(id: string, body: ComputerUpdate): Promise<Computer>
```

`PATCH /v1/computers/{id}`. Renames the computer: `body` is `{ name }`, and the name is the only field you can change after create — any other field is `400 validation_failed`.

## inspect

```ts theme={"system"}
client.computers.inspect(id: string): Promise<ComputerInspect>
```

`GET /v1/computers/{id}/inspect`. What the machine is doing now: `status`, `last_active_at`, `home` (the directory the `fs` calls are rooted in, `/home/naive`) and, only while it is running, a `probe` sample of uptime, processes, load, memory and disk. It never wakes a paused computer (`probe` is then `null`). It needs the `computers:write` scope because the probe runs a command on the machine.

## exec

```ts theme={"system"}
client.computers.exec(id: string, command: string, timeoutMs?: number): Promise<ExecResult>
```

`POST /v1/computers/{id}/exec`. Runs a shell command and answers when it exits:

```json theme={"system"}
{ "stdout": "...", "stderr": "", "exit_code": 0, "duration_ms": 412, "timed_out": false, "truncated": false }
```

`timeoutMs` (a number, the third argument) maps to the `timeout_ms` body field: when it elapses the command and the processes it started are killed, with `exit_code` `124` and `timed_out: true`. `truncated` is `true` when `stdout` or `stderr` was cut at 262 144 characters. A paused computer is resumed to run the command.

## execStream

```ts theme={"system"}
client.computers.execStream(id: string, command: string, opts?: { timeoutMs?: number }): AsyncGenerator<ExecStreamFrame>
```

`POST /v1/computers/{id}/exec/stream`. The same run as `exec`, frame by frame as the process produces output: `{ stdout }` and `{ stderr }` chunks, then exactly one `{ exit }` frame with `exit_code`, `timed_out`, `truncated`, `duration_ms` and the `command_id` the run was recorded as. One connection; it does not resume.

```ts theme={"system"}
for await (const frame of client.computers.execStream(id, "npm test", { timeoutMs: 120_000 })) {
  if ("stdout" in frame) process.stdout.write(frame.stdout);
  else if ("stderr" in frame) process.stderr.write(frame.stderr);
  else console.log("exit", frame.exit.exit_code);
}
```

## commands

```ts theme={"system"}
client.computers.commands(id: string, query?: ListQuery): Promise<Page<ComputerCommand>>
```

`GET /v1/computers/{id}/commands`, cursor-paginated, newest first. One row per `exec` or `execStream` run: `command`, `exit_code`, `timed_out`, `duration_ms`, `stdout`/`stderr` (each capped at 65,536 characters, `truncated` when cut), the `actor` who ran it and `created_at`. Rows are kept for 30 days. Commands an agent runs in a session are not here; they are events on the session. Needs `computers:write`.

## pause / resume

```ts theme={"system"}
client.computers.pause(id: string): Promise<Computer>
client.computers.resume(id: string): Promise<Computer>
```

`POST /v1/computers/{id}/pause` and `POST /v1/computers/{id}/resume`. Paused bills **nothing** (disk is never metered) — the first efficiency lever. Resume brings the same disk back. Pausing a computer you created does not refund the rest of its 10-minute block already paid, and any exec, fs, snapshot or execStream call on a paused computer resumes it, so billing restarts.

## snapshot

```ts theme={"system"}
client.computers.snapshot(id: string): Promise<Snapshot>
```

`POST /v1/computers/{id}/snapshot`. Captures the filesystem for fast restore; pass the returned `snapshot_id` to `create` as `snapshot_id`. It takes no options — a snapshot has no name.

```ts theme={"system"}
const { snapshot_id } = await client.computers.snapshot(id);
const fork = await client.computers.create({ name: "box-2", snapshot_id });
```

## listSnapshots / deleteSnapshot

```ts theme={"system"}
client.computers.listSnapshots(query?: ListQuery): Promise<Page<Snapshot>>
client.computers.deleteSnapshot(snapshotId: string): Promise<Deleted>
```

`GET /v1/snapshots` (cursor-paginated, newest first) and `DELETE /v1/snapshots/{id}`. A delete is refused with `409 state_conflict` while a live computer was restored from the snapshot.

## takeOver / handBack

```ts theme={"system"}
client.computers.takeOver(id: string): Promise<Computer>
client.computers.handBack(id: string): Promise<Computer>
```

`POST /v1/computers/{id}/takeover` and `DELETE /v1/computers/{id}/takeover`, on an [agent's computer](https://vetta.sh/docs/api/computers.md#an-agents-computer) only. While you hold it, the agent's sessions **wait** until you hand it back, and your time on it is not billed. Taking over is `409 computer_unavailable` while a session is using the computer, and on a computer you created. A takeover you do not hand back ends after an hour.

## fs

```ts theme={"system"}
client.computers.fs(id: string, op: FsOp, body: Record<string, string>): Promise<unknown>
```

One method parameterized over the five `/v1/computers/{id}/fs/*` routes — `FsOp` is `"read" | "write" | "list" | "mkdir" | "remove"`. Splitting it would produce five near-identical methods with no added type safety. The reply differs per op (`{content}`, `{entries}`, `{created}`, …), so it comes back unparsed.

Every op takes an absolute `path`, **inside the computer's home directory** — the `home` that `computers.inspect(id)` reports, `/home/naive`; a path outside it is refused with `403 forbidden` by every op. In a command, write `~` or `$HOME` instead: the shell sees the machine's own name for it. `remove` refuses `/`, the home itself and any folder that holds it (`400 validation_failed`). `read` and `write` also take `encoding` (`"text"` default, `"base64"` for binary) and `write` takes `content`:

```ts theme={"system"}
await client.computers.fs(id, "write", { path: "/home/naive/hello.txt", content: "hi\n" });
const file = await client.computers.fs(id, "read", { path: "/home/naive/hello.txt" });
const dir = await client.computers.fs(id, "list", { path: "/home/naive" });
```

Bodies and per-op replies are specified in the [filesystem API reference](https://vetta.sh/docs/api/computers.md#filesystem).

## listDir

```ts theme={"system"}
client.computers.listDir(id: string, path: string): Promise<FileEntry[]>
```

`POST /v1/computers/{id}/fs/list`, typed: the same route as `fs(id, "list", { path })`, parsed. Each entry has `name`, `path`, `type` (`file`, `directory`, `symlink` or `other`), `size_bytes`, `mode` and `modified_at` (`null` when the filesystem does not report one). The path must be inside the home directory.

## build3d

```ts theme={"system"}
client.computers.build3d(id: string, body: Build3dRequestInput): Promise<Build3dResult>
```

`POST /v1/computers/{id}/build-3d`. Runs a build123d (`engine: "cad"`, millimetres) or Blender (`engine: "blender"`, metres) script in the computer, checks it, renders previews and publishes the exports:

```ts theme={"system"}
const build = await client.computers.build3d(id, {
  engine: "cad",
  name: "plate",
  script: "from build123d import *\nresult = Box(60, 40, 4)",
  export: ["step", "stl"],
  render: { views: ["iso", "top"] },
});
if (!build.ok) console.log(build.error?.message, build.error?.line);
```

A failing script resolves with `ok: false` and `error: { message, line }`; it does not throw. Both types are exported: `import type { Build3dRequestInput, Build3dResult } from "@usenaive-sdk/managed-agents"`. Fields, limits and the checks are in the [API reference](https://vetta.sh/docs/api/computers.md#build-a-3d-model).

## delete

```ts theme={"system"}
client.computers.delete(id: string): Promise<Deleted>
```

`DELETE /v1/computers/{id}`. Destroys the machine and its disk. Snapshots survive.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.