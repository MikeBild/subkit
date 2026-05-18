// Single source of truth for projecting the per-request
// `request_source` from the Hono context onto audit metadata.
//
// Every route that emits a `FILE_*` (or any other) audit row whose
// metadata schema carries an optional `request_source` field MUST go
// through this helper instead of reading `c.get("request_source")`
// raw. The helper allow-lists values against the canonical
// `RequestSourceSchema` (in observability/service-metadata.ts) so a
// route wired under a path the trace middleware tags with a future
// value never causes the audit-metadata `.parse(...)` to throw and
// abort the request.

import type { Context } from "hono";
import { type RequestSource, RequestSourceSchema } from "../observability/service-metadata.ts";

/** Project the trace-middleware-set `request_source` onto the
 *  canonical enum. Returns `undefined` when the variable is missing
 *  (raw test invocations that skip the middleware) or carries a
 *  value the schema does not recognise. Never throws — the audit row
 *  is the compliance-of-record and must not be the source of a
 *  request-aborting error. */
export function readRequestSource(c: Context): RequestSource | undefined {
  const raw = c.get("request_source") as unknown;
  const parsed = RequestSourceSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
