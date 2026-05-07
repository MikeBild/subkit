// Build-time embedded migration bundle (issue #149).
//
// We import each migration's raw SQL as text and the journal as JSON.
// `bun build --compile` inlines the contents of every imported text /
// JSON asset into the binary, so the runtime never reads the
// filesystem and the engine + migration set ship as a single artifact.
//
// Drift safeguard: `migrate-embedded-bundle.test.ts` re-reads the
// on-disk SQL files at test time and asserts every embedded body's
// SHA-256 matches the file. CI fails loudly if a new migration is
// added but not registered here.

import { createHash } from "node:crypto";
import sql0000 from "./0000_v3_baseline.sql" with { type: "text" };
import sql0001 from "./0001_settings.sql" with { type: "text" };
import sql0002 from "./0002_connectors_partial_unique_slug.sql" with { type: "text" };
import sql0003 from "./0003_workflow_versions_scope_index.sql" with { type: "text" };
import sql0004 from "./0004_credential_mode_aws_sigv4.sql" with { type: "text" };
import sql0005 from "./0005_enable_prompt_cache_default_true.sql" with { type: "text" };
import sql0006 from "./0006_skill_metadata_overhaul.sql" with { type: "text" };
import sql0007 from "./0007_webhooks_inbound_origin.sql" with { type: "text" };
import sql0008 from "./0008_drop_chat_link_tokens.sql" with { type: "text" };
import sql0009 from "./0009_drop_tenant_settings.sql" with { type: "text" };
import sql0010 from "./0010_workflow_run_state.sql" with { type: "text" };
import sql0011 from "./0011_workflow_waits.sql" with { type: "text" };
import sql0012 from "./0012_workflow_signals.sql" with { type: "text" };
import sql0013 from "./0013_credential_mode_token_mint.sql" with { type: "text" };
import journalMeta from "./meta/_journal.json" with { type: "json" };

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  breakpoints?: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export interface EmbeddedMigration {
  idx: number;
  tag: string;
  when: number;
  hash: string;
  statements: string[];
}

const SQL_BY_TAG: Record<string, string> = {
  "0000_v3_baseline": sql0000,
  "0001_settings": sql0001,
  "0002_connectors_partial_unique_slug": sql0002,
  "0003_workflow_versions_scope_index": sql0003,
  "0004_credential_mode_aws_sigv4": sql0004,
  "0005_enable_prompt_cache_default_true": sql0005,
  "0006_skill_metadata_overhaul": sql0006,
  "0007_webhooks_inbound_origin": sql0007,
  "0008_drop_chat_link_tokens": sql0008,
  "0009_drop_tenant_settings": sql0009,
  "0010_workflow_run_state": sql0010,
  "0011_workflow_waits": sql0011,
  "0012_workflow_signals": sql0012,
  "0013_credential_mode_token_mint": sql0013,
};

const journal = journalMeta as unknown as Journal;

function buildBundle(): EmbeddedMigration[] {
  return journal.entries
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((e) => {
      const raw = SQL_BY_TAG[e.tag];
      if (raw === undefined) {
        // Caught by `migrate-embedded-bundle.test.ts` in CI long before
        // a binary ships.
        throw new Error(
          `embedded.ts is out of sync with meta/_journal.json: missing SQL for tag '${e.tag}'`,
        );
      }
      const statements = raw
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const hash = createHash("sha256").update(raw).digest("hex");
      return { idx: e.idx, tag: e.tag, when: e.when, hash, statements };
    });
}

export const EMBEDDED_MIGRATIONS: readonly EmbeddedMigration[] = buildBundle();
export const EMBEDDED_JOURNAL: Journal = journal;
