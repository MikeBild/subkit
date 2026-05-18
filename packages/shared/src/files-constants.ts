// Shared file-handling constants — single source of truth for both
// the engine (validation + 413 response) and the CLI (size-based
// routing between inline upload and presigned PUT).
//
// Drift between the two halves used to be invisible until a 5 MiB-
// boundary file either:
//   - went through `/v1/files/inline` and got 413'd, or
//   - went through the presigned PUT path needlessly when the engine
//     would still have accepted it inline.
// Both halves now read the same constant; bumping the cap is a
// one-line change with both surfaces aligned.

/** Hard cap on inline-upload payload size. Above this the client
 *  must go through the presigned-PUT path
 *  (`/v1/files/batch-create` → `PUT <upload_url>` →
 *  `/v1/files/:id/finalize`). Mirrors the legacy 10 MB
 *  conversation-attachment cap, halved because base64 inflates the
 *  JSON body by ~33% so a 5 MiB payload lands as ~7 MiB on the
 *  wire. */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024;
