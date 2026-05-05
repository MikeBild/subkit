// One-shot migration helper for v3.4.x → v3.5.0 operators.
//
// Reads `engine_settings` rows + every tenant's `tenants.settings` JSONB
// and writes them to `legacy-settings-export.json` so the operator can
// reference the values when populating `subkit.config.json` via
// `sk settings configure`.
//
// Usage (run against a v3.4.x database, before deploying v3.5.0):
//   bun run apps/engine/scripts/export-legacy-settings.ts > legacy-settings-export.json
//
// The script reads-only from the database. It does not mutate state.
// Sensitive values are written verbatim — operators should treat the
// output file as a secret and delete it after use.

import { Pool } from "pg";

interface LegacyExport {
  exported_at: string;
  global_settings: Record<string, unknown>;
  tenant_settings: Record<string, Record<string, unknown>>;
  notes: string[];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write("DATABASE_URL is required\n");
    process.exit(2);
  }

  const pool = new Pool({ connectionString: url });
  const out: LegacyExport = {
    exported_at: new Date().toISOString(),
    global_settings: {},
    tenant_settings: {},
    notes: [
      "v3.4.x settings export — for reference when populating subkit.config.json via `sk settings configure`",
      "Sensitive values are present verbatim. Delete this file after the v3.5.0 upgrade is complete.",
    ],
  };

  try {
    // Probe whether the legacy `engine_settings` table even exists.
    // On a database that was created at v3.5+ the table is absent and we
    // exit with an empty export rather than a SQL error.
    const tablesExist = await pool.query<{ engine_settings: boolean; tenants_settings: boolean }>(
      `SELECT
         to_regclass('public.engine_settings') IS NOT NULL AS engine_settings,
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'tenants' AND column_name = 'settings'
         ) AS tenants_settings`,
    );
    const probe = tablesExist.rows[0];
    if (!probe?.engine_settings && !probe?.tenants_settings) {
      out.notes.push("No legacy settings table found — database is already v3.5+.");
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }

    if (probe.engine_settings) {
      const rows = await pool.query<{ key: string; value: unknown }>(
        "SELECT key, value FROM engine_settings",
      );
      for (const row of rows.rows) {
        out.global_settings[row.key] = row.value;
      }
    }

    if (probe.tenants_settings) {
      const rows = await pool.query<{ id: string; slug: string; settings: unknown }>(
        "SELECT id, slug, settings FROM tenants WHERE settings IS NOT NULL AND jsonb_typeof(settings) = 'object' AND settings <> '{}'::jsonb",
      );
      for (const row of rows.rows) {
        const overrides = row.settings as Record<string, unknown>;
        if (overrides && Object.keys(overrides).length > 0) {
          out.tenant_settings[row.id] = overrides;
        }
      }
    }

    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(
    `export-legacy-settings failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
