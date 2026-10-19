import type pg from "pg";
import { getConfig, isConfigLoaded } from "../config/loader.ts";
import { type Config, DatabaseConfigSchema } from "../config/schema.ts";

export type DatabaseConnectionSettings = Omit<Config["database"], "url">;

export const APPLICATION_SEARCH_PATH = "subkit,pg_catalog,public";
export const MIGRATION_SEARCH_PATH = "public,pg_catalog";

export function databaseConnectionSettings(): DatabaseConnectionSettings {
  return isConfigLoaded() ? getConfig().database : DatabaseConfigSchema.parse({ url: "bootstrap" });
}

export function databaseClientOptions(
  connectionString: string,
  settings = databaseConnectionSettings(),
) {
  return {
    connectionString,
    keepAlive: true,
    keepAliveInitialDelayMillis: settings.keepalive_delay_ms,
    connectionTimeoutMillis: settings.connect_timeout_ms,
    query_timeout: settings.query_timeout_ms,
  };
}

export async function initializeDatabaseSession(
  client: Pick<pg.ClientBase, "query">,
  settings: DatabaseConnectionSettings,
  searchPath = APPLICATION_SEARCH_PATH,
): Promise<void> {
  await client.query(
    "SELECT set_config('search_path', $1, false), set_config('statement_timeout', $2, false)",
    [searchPath, String(settings.statement_timeout_ms)],
  );
}

export function databasePoolOptions(
  connectionString: string,
  settings = databaseConnectionSettings(),
  migration = false,
) {
  return {
    ...databaseClientOptions(connectionString, settings),
    max: migration ? 1 : settings.pool_max,
    idleTimeoutMillis: settings.idle_timeout_ms,
    onConnect: (client: pg.ClientBase) =>
      initializeDatabaseSession(
        client,
        settings,
        migration ? MIGRATION_SEARCH_PATH : APPLICATION_SEARCH_PATH,
      ),
  };
}
