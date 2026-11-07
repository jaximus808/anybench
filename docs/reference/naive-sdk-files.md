> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# files

> Upload, import, find, describe and publish artifacts — client.files.

Files are session scratch until published, then durable org artifacts — and, with a title and tags, the asset library an agent searches with `find_files`. Fourteen methods here. API detail: [Files](https://vetta.sh/docs/api/files.md).

## upload

```ts theme={"system"}
client.files.upload(form: FormData): Promise<File>
```

`POST /v1/files`, `multipart/form-data` — the one method in the client that does not send JSON. The `file` part carries the bytes; other parts are metadata:

```ts theme={"system"}
const form = new FormData();
form.append("file", new Blob([bytes], { type: "application/pdf" }), "invoice.pdf");
form.append("title", "Invoice 4821");
form.append("tags", "finance,q3");
const file = await client.files.upload(form);
```

`title`, `description`, `tags` (comma-separated) and `folder` are optional; the body is capped at 25 MiB. The stored file carries `kind` (derived from the content type), `source: { type: "upload" }` and, for an image, its `width`/`height`.

## createUpload

```ts theme={"system"}
client.files.createUpload(body: { name: string; content_type: string; size_bytes: number; folder?: string }): Promise<FileUploadTicket>
```

`POST /v1/files/uploads`. A one-shot link for up to 60 MiB: PUT the bytes to `upload_url` within 15 minutes, with the same `Content-Type` and a `Content-Length` of exactly `size_bytes`. The PUT needs no key, so a browser can send the bytes straight to it. Its answer is the `published` file, with the id `file_id` already named.

```ts theme={"system"}
const ticket = await client.files.createUpload({ name: "clip.mp4", content_type: "video/mp4", size_bytes: blob.size });
await fetch(ticket.upload_url, { method: "PUT", headers: { "content-type": "video/mp4" }, body: blob });
```

## import

```ts theme={"system"}
client.files.import(body: FileImport): Promise<File>
```

`POST /v1/files/imports`. The API fetches a public `http(s)` URL server-side and stores it as a `published` file with `source.type: "url_import"`. The client sends the `Idempotency-Key` for you, so a retried call replays the same file.

```ts theme={"system"}
const hero = await client.files.import({
  url: "https://cdn.example.com/hero.png",
  title: "Launch hero",
  tags: ["launch"],
});
```

**url** `string` *required*

Public `http(s)` URL; private and local hosts are refused.

**title** `string`

A human title.

**description** `string`

A longer, searchable description.

**tags** `string[]`

Labels to filter by.

**folder** `string`

Put the file in this folder.

## list

```ts theme={"system"}
client.files.list(query?: FileFilter): Promise<Page<File>>
```

`GET /v1/files`. `FileFilter` extends the [page query](https://vetta.sh/docs/sdk/pagination.md) with:

**scope** `"session" | "published"`

Only scratch, or only published artifacts.

**session\_id** `string`

Only files a given session produced.

**kind** `string`

`image`, `video`, `audio`, `document` or `other`, or several comma-separated.

**exclude\_kind** `string`

None of these kinds, comma-separated.

**agent\_id** `string`

Only files an agent's sessions made.

**ids** `string`

Exactly these files: up to 100 `fil_` ids, comma-separated.

**source** `FileSourceType`

Provenance — `upload`, `url_import`, `image_generation`, …

**tag** `string`

Only files carrying this tag.

**search** `string`

Case-insensitive substring of the title, name or description.

**order** `"desc" | "asc"`

Newest first (the default) or oldest first.

**folder** `string`

Only files in this folder. Case does not matter.

```ts theme={"system"}
const heroes = await client.files.list({ kind: "image", tag: "launch", search: "hero" });
// An agent's pictures and clips, newest first — each carries `agent_id` and `source.model`/`source.prompt`.
const made = await client.files.list({ kind: "image,video", agent_id: "agt_01H9CD..." });
```

## get

```ts theme={"system"}
client.files.get(id: string): Promise<File>
```

`GET /v1/files/{id}` — the metadata object.

## update

```ts theme={"system"}
client.files.update(id: string, body: FileUpdate): Promise<File>
```

`PATCH /v1/files/{id}`. Library metadata only — `title`, `description` (each a string, or `null` to clear), `tags` (replaces the list) and `folder` (a name, or `null` to take the file out of its folder). The bytes, name, scope and provenance never change.

```ts theme={"system"}
await client.files.update(hero.id, { title: "Launch hero (final)", tags: ["launch", "approved"] });
```

## move

```ts theme={"system"}
client.files.move(body: { ids?: string[]; from?: string; folder: string | null }): Promise<FileMove>
```

`POST /v1/files/move`. Puts up to 100 files (`ids`) in a folder, or moves every file in the folder `from`: a rename, or a merge when `folder` is already in use. `folder: null` takes the files out of any folder. Name `ids` or `from`, not both. The answer is `{ object: "file_move", folder, file_ids }`, where `folder` is the spelling that won: a name that matches an existing folder in another case takes that folder's spelling. No file is ever deleted.

```ts theme={"system"}
await client.files.move({ ids: [hero.id], folder: "Launch" });
await client.files.move({ from: "Launch", folder: "Launch 2026" });
```

## folders

```ts theme={"system"}
client.files.folders(): Promise<Page<FileFolderInfo>>
```

`GET /v1/files/folders`. Every folder, newest first, in one page. Each has `name`, `file_count`, `newest_at`, `cover_file_ids` (up to four of its newest pictures and clips) and `agent_id` (the one agent that made every file in it, else `null`). Read a folder's files with `list({ folder })`. See [Folders](https://vetta.sh/docs/api/files.md#folders).

## download

```ts theme={"system"}
client.files.download(id: string): Promise<string>
```

`GET /v1/files/{id}?download=true` — the file decoded as UTF-8 text, through the API. A download is authorized by the same key as every other read; for an address that needs no key, mint one with [`url`](#url). For text only: an image, audio or video file comes back mangled, so use [`downloadBytes`](#downloadbytes).

## downloadBytes

```ts theme={"system"}
client.files.downloadBytes(id: string): Promise<Uint8Array>
```

The same download, as the exact bytes. Use it for any binary file:

```ts theme={"system"}
await writeFile("hero.png", await client.files.downloadBytes(file.id));
```

## url

```ts theme={"system"}
client.files.url(id: string): Promise<{ object: "file_url"; url: string; expires_at: string }>
```

`POST /v1/files/{id}/url`. An address for the file that needs no key, good for seven days: what an `<img>` or `<video>` tag can open. Any file can have one, scratch or published, and a key with `files:read` can mint it. Anyone holding the link can read the file until `expires_at`, so share it like a password.

```ts theme={"system"}
const { url, expires_at } = await client.files.url(file.id);
```

## publish

```ts theme={"system"}
client.files.publish(id: string): Promise<File>
```

`POST /v1/files/{id}/publish`. The promotion boundary: session scratch becomes a durable org artifact. Idempotent — publishing twice is fine.

## delete

```ts theme={"system"}
client.files.delete(id: string): Promise<Deleted>
```

`DELETE /v1/files/{id}`.

## deleteMany

```ts theme={"system"}
client.files.deleteMany(body: { ids: string[] }): Promise<FileDelete>
```

`POST /v1/files/delete`. Deletes up to 100 files in one request. An id the organization does not hold is skipped. The answer is `{ object: "file_delete", file_ids }`, the ids that were deleted.

```ts theme={"system"}
await client.files.deleteMany({ ids: [hero.id, draft.id] });
```


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.