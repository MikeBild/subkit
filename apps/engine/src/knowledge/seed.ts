// Embedded Knowledge-Source seeding.
//
// Mirrors the skill-seed machinery (`skills/seed.ts`): the seed Markdown
// library is **embedded** at build time via `with { type: "text" }` imports
// (see `embedded-seeds.ts`), so every compiled `engine` binary carries the
// seed contents inline. There is no runtime fs.readdir and no fallback
// search path; the seeds ship with the binary, period.
//
// Upsert strategy: `(tenant_id, slug)` is unique. We look up an existing row
// by that pair; the row's `version` is the 32-char SHA-256 prefix of the
// ingested content (same fingerprint `createKnowledgeSource` derives). When
// the body's fingerprint differs we re-ingest to rotate chunks + version;
// otherwise we skip.
//
// We deliberately REUSE the service functions (`createKnowledgeSource`,
// `ingestKnowledgeSource`) verbatim — there is no third chunk-insert path.
//
// Front-matter contract (6 keys):
//
//     ---
//     slug: sk-ref-rest-api
//     name: sk Platform Reference — REST API
//     description: One-liner.
//     tags: [sk-platform-reference, rest-api]
//     scope: global
//     version: 1
//     ---
//     <markdown body>

import { createHash } from "node:crypto";
import { type Db, getDb } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { EMBEDDED_KNOWLEDGE_SEEDS } from "./embedded-seeds.ts";
import {
  createKnowledgeSource,
  getKnowledgeSourceBySlug,
  ingestKnowledgeSource,
} from "./service.ts";

export interface SeededKnowledge {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  scope: "global" | "workflow";
  /** Informational seed-author version from frontmatter. The persisted row
   *  version is the content fingerprint, not this number. */
  version: number;
  /** Markdown body with the frontmatter stripped — this is what gets ingested. */
  body: string;
}

export interface ParseError {
  file: string;
  code: "missing_frontmatter" | "missing_key" | "bad_yaml" | "bad_scope";
  message: string;
}

export interface LoadResult {
  knowledge: SeededKnowledge[];
  errors: ParseError[];
  /** Number of `*.md` files embedded in the binary at build time. */
  embedded_count: number;
}

export interface ApplyOutcome {
  tenant_id: string;
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface SeedSource {
  file: string;
  content: string;
}

/**
 * Parse every Markdown Knowledge seed embedded in the binary.
 */
export function loadEmbeddedKnowledgeSeeds(): LoadResult {
  return loadKnowledgeSeedsFromContent(EMBEDDED_KNOWLEDGE_SEEDS);
}

/**
 * Parse a caller-supplied list of seed sources. Used by tests to feed
 * synthetic Markdown without touching the filesystem; production code should
 * call `loadEmbeddedKnowledgeSeeds()` instead.
 */
export function loadKnowledgeSeedsFromContent(files: readonly SeedSource[]): LoadResult {
  const out: SeededKnowledge[] = [];
  const errors: ParseError[] = [];
  for (const entry of files) {
    const parsed = parseFrontmatter(entry.content, entry.file);
    if ("error" in parsed) {
      errors.push(parsed.error);
      continue;
    }
    out.push(parsed.knowledge);
  }
  return { knowledge: out, errors, embedded_count: files.length };
}

export async function applyKnowledgeSeeds(
  seeds: SeededKnowledge[],
  tenant_id: string,
  db: Db = getDb(),
): Promise<ApplyOutcome> {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const s of seeds) {
    // Same fingerprint `createKnowledgeSource`/`ingestKnowledgeSource` store
    // as `version` — derived from the exact bytes we ingest.
    const version = createHash("sha256").update(s.body).digest("hex").slice(0, 32);
    const buffer = Buffer.from(s.body, "utf8");
    const existing = await getKnowledgeSourceBySlug(tenant_id, s.slug, db);
    if (!existing) {
      await createKnowledgeSource(
        {
          tenant_id,
          actor_id: null,
          input: {
            name: s.name,
            slug: s.slug,
            description: s.description,
            tags: s.tags,
            scope: "global",
          },
          upload: { buffer, filename: `${s.slug}.md`, mime: "text/markdown" },
          source_type_override: "seed",
        },
        db,
      );
      inserted++;
      continue;
    }
    // A non-seed source occupying a seed slug (a user deleted the seed and
    // imported their own bundle under the same slug — possible since the
    // tenant+slug unique index went partial) must NEVER be overwritten by
    // the boot sweep: re-ingesting seed content over user knowledge would
    // silently destroy it. Same guard the bundle upsert applies (409).
    if (existing.source_type !== "seed") {
      logger.warn({
        module: "knowledge.seed",
        action: "seed.slug_occupied",
        msg: "seed slug is occupied by a non-seed source; leaving it untouched",
        tenant_id,
        slug: s.slug,
        occupying_source_type: existing.source_type,
      });
      unchanged++;
      continue;
    }
    if (existing.version === version) {
      unchanged++;
      continue;
    }
    // Body changed — re-ingest to rotate chunks + version in place.
    await ingestKnowledgeSource(
      {
        tenant_id,
        knowledge_source_id: existing.id,
        upload: { buffer, filename: `${s.slug}.md`, mime: "text/markdown" },
        actor_id: null,
      },
      db,
    );
    updated++;
  }
  return { tenant_id, inserted, updated, unchanged };
}

/** Apply seeded Knowledge Sources to every tenant in the system. Boot path. */
export async function applyKnowledgeSeedsForAllTenants(
  seeds: SeededKnowledge[],
  db: Db = getDb(),
): Promise<ApplyOutcome[]> {
  const allTenants = await db.select({ id: tenants.id }).from(tenants);
  const outcomes: ApplyOutcome[] = [];
  for (const t of allTenants) {
    const r = await applyKnowledgeSeeds(seeds, t.id, db);
    outcomes.push(r);
  }
  return outcomes;
}

/**
 * Boot orchestrator: load the embedded Knowledge-Source library and upsert
 * every source into every tenant. Mirrors the skill seed at boot — the
 * persisted `version` is the content fingerprint, so unchanged seeds are a
 * no-op on subsequent boots (no chunk churn). Intended to be called
 * fire-and-forget (`void seedKnowledgeAtBoot(db)`): it never throws, runs in
 * the background so a large catalog never delays the first HTTP request, and
 * is always on — no env gate.
 */
export async function seedKnowledgeAtBoot(db: Db = getDb()): Promise<void> {
  try {
    const loaded = loadEmbeddedKnowledgeSeeds();
    if (loaded.errors.length > 0) {
      logger.warn({
        module: "knowledge.seed",
        action: "seed.parse_errors",
        msg: "some embedded knowledge seeds failed to parse",
        errors: loaded.errors.map((e) => ({ file: e.file, code: e.code })),
      });
    }
    if (loaded.knowledge.length === 0) {
      logger.info({
        module: "knowledge.seed",
        action: "seed.empty",
        msg: "no knowledge seeds embedded in this binary; skipping",
        embedded_count: loaded.embedded_count,
      });
      return;
    }
    const outcomes = await applyKnowledgeSeedsForAllTenants(loaded.knowledge, db);
    const totals = outcomes.reduce(
      (acc, o) => {
        acc.inserted += o.inserted;
        acc.updated += o.updated;
        acc.unchanged += o.unchanged;
        return acc;
      },
      { inserted: 0, updated: 0, unchanged: 0 },
    );
    logger.info({
      module: "knowledge.seed",
      action: "seed.applied",
      msg: "knowledge seeds applied across tenants",
      tenants: outcomes.length,
      sources_per_tenant: loaded.knowledge.length,
      embedded_count: loaded.embedded_count,
      ...totals,
    });
  } catch (err) {
    logger.error({
      module: "knowledge.seed",
      action: "seed.failed",
      msg: "knowledge seed apply failed (non-fatal)",
      ...errorFields(err),
    });
  }
}

// ---------------------------------------------------------------------------

type ParseOk = { knowledge: SeededKnowledge };
type ParseFail = { error: ParseError };

function parseFrontmatter(raw: string, file: string): ParseOk | ParseFail {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    return {
      error: {
        file,
        code: "missing_frontmatter",
        message: "expected YAML frontmatter between --- markers",
      },
    };
  }
  const block = match[1]!;
  const body = (match[2] ?? "").trim();
  const fm: Record<string, unknown> = {};
  for (const lineRaw of block.split(/\r?\n/)) {
    const line = lineRaw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) {
      return { error: { file, code: "bad_yaml", message: `line missing ':' — '${line}'` } };
    }
    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();
    fm[key] = parseScalar(rest);
  }

  const slug = String(fm.slug ?? "");
  const name = String(fm.name ?? "");
  const description = String(fm.description ?? "");
  const scope = String(fm.scope ?? "");
  const version = typeof fm.version === "number" ? fm.version : 1;

  if (!slug || !name || !description || !scope) {
    return {
      error: {
        file,
        code: "missing_key",
        message: `frontmatter requires slug, name, description, scope (got: ${JSON.stringify(fm)})`,
      },
    };
  }
  if (scope !== "global" && scope !== "workflow") {
    return { error: { file, code: "bad_scope", message: `invalid scope '${scope}'` } };
  }

  const tags = Array.isArray(fm.tags) ? fm.tags.map((v) => String(v)) : [];

  return {
    knowledge: { slug, name, description, tags, scope, version, body },
  };
}

function parseScalar(raw: string): unknown {
  if (raw === "") return "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Flow array of scalars: `[a, b, c]`.
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => {
      const t = s.trim();
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1);
      }
      return t;
    });
  }
  const n = Number(raw);
  if (!Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(raw)) return n;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}
