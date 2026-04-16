// HTML source normalizer — STUB.
//
// HTML scraping requires a headless browser so we can drive JS-rendered
// docs sites. That means pulling in `playwright` which is heavy; we
// explicitly keep it out of P6 and fail fast if anyone tries to use it.
// A later phase will lazy-load the optional dep and wire it in here.

import { type IngestSourceInput, NotImplementedError } from "../types.ts";

export function ingestHtml(_input: IngestSourceInput): never {
  throw new NotImplementedError("html ingestion requires playwright in a later phase");
}
