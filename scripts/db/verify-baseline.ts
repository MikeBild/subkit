// Diagnostic for the v3 baseline upgrade.
//
// Reports which of three states the target database is in and whether
// the in-tree baseline matches what's recorded:
//
//   FRESH       __drizzle_migrations is empty — `bun run db:migrate`
//               will apply the baseline cleanly.
//   PRE-UPGRADE 41 or 42 rows present (2.x line, optionally with the
//               0041 egress-guard column commit). Run
//               `scripts/db/upgrade-to-v3-baseline.sh` to consolidate.
//   BASELINED   exactly one row whose hash matches the in-tree
//               0000_v3_baseline.sql — nothing to do.
//
// Exits non-zero on UNEXPECTED, zero on the three recognised states so
// it can drop straight into deploy preflight without false alarms.
//
// REQUIRED env: DATABASE_URL.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const BASELINE_SQL = path.join(REPO, "apps/engine/src/db/migrations/0000_v3_baseline.sql");
const JOURNAL = path.join(REPO, "apps/engine/src/db/migrations/meta/_journal.json");

type State = "FRESH" | "PRE_UPGRADE" | "BASELINED" | "UNEXPECTED";

interface Report {
  state: State;
  rows: number;
  expected_hash: string;
  expected_when: number;
  matching_hash: number;
  notes: string[];
}

function readBaselineHash(): string {
  return createHash("sha256").update(readFileSync(BASELINE_SQL)).digest("hex");
}

function readBaselineWhen(): number {
  const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as {
    entries: Array<{ idx: number; when: number }>;
  };
  const entry = journal.entries.find((e) => e.idx === 0);
  if (!entry) throw new Error("baseline entry missing from meta/_journal.json");
  return entry.when;
}

async function inspect(url: string): Promise<Report> {
  const expected_hash = readBaselineHash();
  const expected_when = readBaselineWhen();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const tableExists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
       ) AS exists`,
    );
    if (!tableExists.rows[0]?.exists) {
      return {
        state: "FRESH",
        rows: 0,
        expected_hash,
        expected_when,
        matching_hash: 0,
        notes: ["drizzle.__drizzle_migrations does not exist yet"],
      };
    }
    const counts = await client.query<{ rows: string; matching_hash: string }>(
      `SELECT count(*)::text AS rows,
              count(*) FILTER (WHERE hash = $1)::text AS matching_hash
         FROM drizzle.__drizzle_migrations`,
      [expected_hash],
    );
    const rows = Number(counts.rows[0]?.rows ?? 0);
    const matching_hash = Number(counts.rows[0]?.matching_hash ?? 0);

    const notes: string[] = [];
    let state: State;
    if (rows === 0) {
      state = "FRESH";
    } else if (rows === 1 && matching_hash === 1) {
      state = "BASELINED";
    } else if (rows === 41 || rows === 42) {
      state = "PRE_UPGRADE";
      notes.push(
        `run scripts/db/upgrade-to-v3-baseline.sh <pg_dump_path> to consolidate ${rows} rows into the baseline`,
      );
    } else if (rows === 1 && matching_hash === 0) {
      state = "UNEXPECTED";
      notes.push("one row present but its hash does not match the in-tree baseline");
    } else {
      state = "UNEXPECTED";
      notes.push(`${rows} rows is neither fresh (0), baselined (1), nor known pre-upgrade (41/42)`);
    }
    return { state, rows, expected_hash, expected_when, matching_hash, notes };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL is required");
    process.exit(2);
  }
  const report = await inspect(url);
  // eslint-disable-next-line no-console -- diagnostic CLI
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.state === "UNEXPECTED" ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
