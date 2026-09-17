# Bounded content publication

SubKit supports the documented ContentKit markdown revision and site release
protocol as a finite repeated-run boundary. It uses public HTTP APIs only.

A successful held preparation supplies the exact item IDs for each revision
step. The human review binds that fixed membership, origin, site, immutable
workflow version, connection authority, validity and run limit. Markdown may
change within a 1 MB per-item ceiling. A new item, another site or a changed
connection requires a new review. Preparation does not publish or grant access.

At dispatch, every revision PUT must match that membership. The HTTP driver
captures the created revision ID from the successful raw response, before
authored output selectors. Release admission loads only those trusted receipts
from succeeded, non-held request steps in the same tenant and execution. The
release must contain exactly one such revision for every approved item.
Authored collectors, other executions and preview output cannot substitute
revision IDs. Partial batches, additional fields including `retire_item_ids`,
method overrides, multipart requests and ambiguous URLs are rejected.

The generic execution authority still checks revocation, expiry, current version,
configuration, credential identity and reservations at every dispatch. Redirects
are disabled. Retries retain existing idempotency behavior; this does not promise
exactly-once writes or undo already-created revisions after a later failure.

Regression coverage lives in `content-publication-boundary.test.ts`,
`content-publication-evidence.integration.test.ts` and
`content-publication-authority.integration.test.ts`. The integration suite uses
real PostgreSQL and a fixture HTTP transport, including loop instances,
tenant/version/environment isolation, transformed output, changed membership,
foreign revision rejection and the preview → human grant → scheduler sequence.
