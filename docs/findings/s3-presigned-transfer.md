# S3 presigned artifact transfer (TDM-32, 3.11)

Code: `packages/envs/src/storage.ts`. Tested against MinIO in Docker, not yet against live Vultr Object Storage.

## Setup

- `minio/minio:latest` was not present locally; the test falls back to `pgsty/minio:latest`
  (`pgsty/minio@sha256:b6bfe723...`, entrypoint `docker-entrypoint.sh`, cmd `server /data` works the same).
- Command: `pnpm --filter @anybench/envs exec vitest run test/storage-minio-tdm32.test.ts`
  Printed: `Test Files 1 passed (1)  Tests 5 passed (5)  Duration 7.70s` (200 MiB multipart up + down included).
- The test maps MinIO's port 9000 to a random free localhost port (`-p 127.0.0.1::9000`) and removes the
  `ab-minio-tdm32` container in `afterAll`.

## What we learned

- `@aws-sdk/client-s3` 3.1164 adds flexible checksum headers by default. They do not belong on a presigned
  URL, so the client is built with `requestChecksumCalculation: "WHEN_REQUIRED"` and
  `responseChecksumValidation: "WHEN_REQUIRED"`.
- `getSignedUrl(..., { signableHeaders: new Set(["content-length"]) })` puts `content-length` into
  `X-Amz-SignedHeaders`. MinIO answers **403** to a PUT whose body length differs from the signed length, so
  a presigned URL cannot store more bytes than were declared. This is what enforces the size cap.
- The presigner hoists `x-amz-*` headers into the query string by default. We keep `x-amz-meta-sha256` as a
  real header (`unhoistableHeaders`), so the uploader must send it; it is signed, and the plan lists it in
  `headers`. HeadObject returns it as `Metadata.sha256`.
- Node's `fetch` sets `content-length` from a `Uint8Array` body, so the uploader drops the plan's
  `content-length` header rather than sending it twice. curl does the same with `--upload-file`.
- MinIO with path-style addressing (`forcePathStyle: true`) and region `us-east-1` works for both
  presigned PUT/GET and multipart (CreateMultipartUpload, presigned UploadPart, ListParts, Complete).

## Open for Vultr

- Vultr Object Storage is Ceph RGW. Check that it also rejects a length mismatch on a presigned PUT with a
  signed `content-length`, and that it keeps `x-amz-meta-sha256` on multipart objects.

## Kit uploads (TDM-217, 19.1)

- Keys: `kits/uploads/<owner>/<upload>.tar.gz` (the user's presigned PUT, `ArtifactStore.createKitUpload`) and
  `kits/files/<owner>/<kit>.tar.gz` (written by the server after validation, `putKitFiles`; never presigned for PUT).
  Both sit outside `runs/`, so no runner plan can reach them. `kits.files_url` is `artifact:<kits/files/... key>`.
- The kit PUT reuses the trial single-PUT signing (signed `content-length` + `x-amz-checksum-sha256`), so the URL
  cannot store other bytes; `getKitUpload` also re-hashes the bytes against `x-amz-meta-sha256`.
- Offline check: `pnpm --filter @anybench/envs exec vitest run test/storage-kits-tdm217.test.ts` printed
  `Tests 7 passed (7)`: `X-Amz-SignedHeaders` contains `content-length`, and the plan carries the three headers.
- Not yet tried against live R2. Open: add an R2 lifecycle rule expiring `kits/uploads/` after 1 day, so a PUT that
  is never completed does not linger (the complete route deletes the object itself, on success and on refusal).
