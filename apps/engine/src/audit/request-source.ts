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

import { logger } from "../logging/logger.ts";
import { type RequestSource, RequestSourceSchema } from "../observability/service-metadata.ts";

/** Project the trace-middleware-set `request_source` onto the
 *  canonical enum. Returns `undefined` when the variable is missing
 *  (raw test invocations that skip the middleware) or carries a
 *  value the schema does not recognise. Never throws — the audit row
 *  is the compliance-of-record and must not be the source of a
 *  request-aborting error.
 *
 *  When a non-undefined raw value is rejected by the schema, emits a
 *  `debug` log so the operator can diagnose a trace-middleware widening
 *  that forgot to update `RequestSourceSchema`. Missing variable
 *  (`undefined` raw) is the common case in tests that skip the
 *  middleware and intentionally silent. */
export function readRequestSource(c: Context): RequestSource | undefined {
  const raw = c.get("request_source") as unknown;
  const parsed = RequestSourceSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (raw !== undefined) {
    logger.debug({
      module: "audit",
      action: "request_source.rejected",
      msg: "trace-middleware set a request_source the audit schema does not recognise",
      raw: typeof raw === "string" ? raw : JSON.stringify(raw),
    });
  }
  return undefined;
}
