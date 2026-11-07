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
