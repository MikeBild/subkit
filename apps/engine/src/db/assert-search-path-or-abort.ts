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
