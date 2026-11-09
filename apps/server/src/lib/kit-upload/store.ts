// TDM-217 [19.1]: where uploaded kits live. The routes use this port; the entries pass the
// `@anybench/envs` ArtifactStore (S3/R2), which implements it, and tests pass an in-memory fake.
//
// Keys (envs kitUploadKey / kitFilesKey):
//   kits/uploads/<owner>/<upload>.tar.gz   the user's presigned PUT (untrusted until validated)
//   kits/files/<owner>/<kit>.tar.gz        the validated tarball, written by the server only
// A stored kit's `files_url` is `artifact:<kits/files/... key>` (kitFilesUrl). The orchestrator
// (TDM-218) reads it back with readKitArchive + writeKitArchive (archive.ts, extract.ts), the
// same checks the upload passed.

export interface KitFileStore {
  createKitUpload(input: {
    ownerId: string;
    uploadId: string;
    sizeBytes: number;
    sha256: string;
    maxBytes: number;
    expiresInSec: number;
  }): Promise<{ key: string; url: string; headers: Record<string, string>; expiresAt: string }>;
  /** Null when nothing was uploaded under this owner and id. Throws over `maxBytes`. */
  getKitUpload(
    ownerId: string,
    uploadId: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; sha256: string } | null>;
  deleteKitUpload(ownerId: string, uploadId: string): Promise<void>;
  putKitFiles(ownerId: string, kitId: string, body: Uint8Array): Promise<{ key: string }>;
  createKitDownload(
    key: string,
    expiresInSec?: number,
  ): Promise<{ url: string; expiresAt: string }>;
}

export const KIT_FILES_URL_SCHEME = "artifact:";

/** `files_url` for a kit tarball stored at `key`. */
export function kitFilesUrl(key: string): string {
  return `${KIT_FILES_URL_SCHEME}${key}`;
}

/** The artifact-store key in a `files_url`, or null when the kit's files live elsewhere. */
export function kitFilesKeyOf(filesUrl: string | null | undefined): string | null {
  if (!filesUrl?.startsWith(KIT_FILES_URL_SCHEME)) return null;
  const key = filesUrl.slice(KIT_FILES_URL_SCHEME.length);
  return key.startsWith("kits/files/") ? key : null;
}
