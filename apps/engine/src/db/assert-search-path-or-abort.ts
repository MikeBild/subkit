// Boot gate: the connection must resolve to the product schema.
//
// Extracted from index.ts rather than inlined there because index.ts sits at
// the 1000-LOC invariant ceiling, and the rule is worth more than the
// convenience of keeping this next to its caller.
//
// The engine takes its search path from the database ROLE now, not from a
// `-c search_path=...` startup option — a pooler in transaction mode rejects
// startup parameters. When the role default is missing the path falls back to
// `"$user", public`, where an unqualified table name resolves against
// pre-isolation objects and the query SUCCEEDS with the wrong rows. Aborting
// is the only failure mode that cannot be mistaken for a healthy engine.

import { logger } from "../logging/logger.ts";
import { assertSearchPath, getPool } from "./client.ts";

export async function assertSearchPathOrAbort(): Promise<void> {
  try {
    await assertSearchPath(getPool());
  } catch (err) {
    logger.fatal({
      module: "engine",
      action: "search_path.failed_aborting_boot",
      msg: "database search path does not resolve to the subkit schema; aborting boot",
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}
