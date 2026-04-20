// Disk-backed skill seeding.
//
// Reads Markdown files from `apps/engine/src/conversations/seed/skills/*.md`,
// parses a minimal YAML front-matter block (only the keys we actually use,
// so we don't take a dependency on `gray-matter`), and upserts each file as
// a row in the `skills` table per tenant.
//
// Upsert strategy: `(tenant_id, slug)` is unique when slug is non-null (see
// migration 0028). We look up an existing row by that pair; if the
// SHA-256 content-hash of the current body differs from the stored body,
// we UPDATE (bumping `version`). Otherwise we skip.
//
// Per-tenant overrides live in `tenant_skill_overrides`. Seed rows are never
// overwritten by operators directly — an operator who wants to override
// inserts/updates a `tenant_skill_overrides` row with `hidden=true` or a
// `body_override`. That keeps the seed channel clean and patchable.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { type Db, getDb } from "../db/client.ts";
import { skills, tenants } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";

export interface SeededSkill {
  slug: string;
  scope: "global" | "connector" | "workflow";
  title: string;
  description: string;
  body: string;
  gates_tools: string[];
  version: number;
  /** sha256 of body; used to detect drift without re-writing the row. */
  body_hash: string;
  auto_load?: boolean;
  trigger_keywords?: string[];
}

export interface ParseError {
  file: string;
  code: "missing_frontmatter" | "missing_key" | "bad_yaml" | "bad_scope";
  message: string;
}

export interface LoadResult {
  skills: SeededSkill[];
  errors: ParseError[];
}

export interface ApplyOutcome {
  tenant_id: string;
  inserted: number;
  updated: number;
  unchanged: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SEED_DIR = path.resolve(HERE, "..", "conversations", "seed", "skills");

export async function loadSkillSeedsFromDisk(dir: string = DEFAULT_SEED_DIR): Promise<LoadResult> {
  const out: SeededSkill[] = [];
  const errors: ParseError[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (_err) {
    // If the directory does not exist (fresh clone without seeds), return
    // an empty result. The engine boots without seeded skills, not a crash.
    logger.info({
      module: "skills.seed",
      action: "seed_dir_missing",
      dir,
      msg: "skill seed directory does not exist; skipping",
    });
    return { skills: [], errors: [] };
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    const raw = await fs.readFile(file, "utf8");
    const parsed = parseFrontmatter(raw, file);
    if ("error" in parsed) {
      errors.push(parsed.error);
      continue;
    }
    out.push(parsed.skill);
  }
  return { skills: out, errors };
}

export async function applySkillSeeds(
  seeds: SeededSkill[],
  tenant_id: string,
  db: Db = getDb(),
): Promise<ApplyOutcome> {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const s of seeds) {
    const existing = await db
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, tenant_id), eq(skills.slug, s.slug)))
      .limit(1);
    const row = existing[0];
    if (!row) {
      await db.insert(skills).values({
        tenant_id,
        slug: s.slug,
        scope: s.scope,
        title: s.title,
        body: s.body,
        examples: {
          examples: [],
          best_practices: [],
          pitfalls: [],
          doc_refs: [],
        },
        lifecycle: "active",
        source: "template",
        version: s.version,
        seed_source: s.body_hash,
        gates_tools: s.gates_tools,
        auto_load: s.auto_load ?? false,
        trigger_keywords: s.trigger_keywords ?? [],
      });
      inserted++;
      continue;
    }
    // Hash-based drift detection — we only UPDATE when the body or
    // metadata actually changed, so boots stay cheap and audit logs
    // aren't spammed.
    if (
      row.seed_source === s.body_hash &&
      row.title === s.title &&
      arraysEqual(row.gates_tools ?? [], s.gates_tools)
    ) {
      unchanged++;
      continue;
    }
    await db
      .update(skills)
      .set({
        title: s.title,
        body: s.body,
        gates_tools: s.gates_tools,
        seed_source: s.body_hash,
        version: Math.max(row.version + 1, s.version),
        auto_load: s.auto_load ?? false,
        trigger_keywords: s.trigger_keywords ?? [],
        updated_at: new Date(),
      })
      .where(eq(skills.id, row.id));
    updated++;
  }
  return { tenant_id, inserted, updated, unchanged };
}

/** Apply seeded skills to every tenant in the system. Intended for boot. */
export async function applySkillSeedsForAllTenants(
  seeds: SeededSkill[],
  db: Db = getDb(),
): Promise<ApplyOutcome[]> {
  const allTenants = await db.select({ id: tenants.id }).from(tenants);
  const outcomes: ApplyOutcome[] = [];
  for (const t of allTenants) {
    const r = await applySkillSeeds(seeds, t.id, db);
    outcomes.push(r);
  }
  return outcomes;
}

// ---------------------------------------------------------------------------

type ParseOk = { skill: SeededSkill };
type ParseFail = { error: ParseError };

function parseFrontmatter(raw: string, file: string): ParseOk | ParseFail {
  // Front-matter format:
  //
  //     ---
  //     slug: foo
  //     scope: global
  //     title: Foo
  //     description: One-liner.
  //     gates_tools: [tool_a, tool_b]     # optional; default []
  //     version: 1
  //     ---
  //     <markdown body>
  //
  // We implement a hand-written parser over the subset of YAML we actually
  // use. It:
  //
  //   - accepts single-line strings (quoted or unquoted)
  //   - accepts flow-style arrays `[a, b, c]`
  //   - rejects multi-line values, nested maps, anchors, references
  //
  // This is enough for the seed contract; a fuller YAML dependency would be
  // overkill and carries parsing-attack surface.
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
    const raw = line.slice(idx + 1).trim();
    fm[key] = parseScalar(raw);
  }

  const slug = String(fm.slug ?? "");
  const scope = String(fm.scope ?? "");
  const title = String(fm.title ?? "");
  const description = String(fm.description ?? "");
  const version = typeof fm.version === "number" ? fm.version : 1;
  const gates_tools = Array.isArray(fm.gates_tools) ? fm.gates_tools.map((v) => String(v)) : [];
  const auto_load = fm.auto_load === true || fm.auto_load === "true";
  const trigger_keywords = Array.isArray(fm.trigger_keywords)
    ? fm.trigger_keywords.map((v) => String(v))
    : [];

  if (!slug || !title || !description || !scope) {
    return {
      error: {
        file,
        code: "missing_key",
        message: `frontmatter requires slug, scope, title, description (got: ${JSON.stringify(fm)})`,
      },
    };
  }
  if (scope !== "global" && scope !== "connector" && scope !== "workflow") {
    return { error: { file, code: "bad_scope", message: `invalid scope '${scope}'` } };
  }
  const body_hash = createHash("sha256").update(body).digest("hex");
  return {
    skill: {
      slug,
      scope,
      title,
      description,
      body,
      gates_tools,
      version,
      body_hash,
      auto_load,
      trigger_keywords,
    },
  };
}

function parseScalar(raw: string): unknown {
  if (raw === "") return "";
  // Quoted string:
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Flow array:
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
  // Number:
  const n = Number(raw);
  if (!Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(raw)) return n;
  // Boolean:
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  for (let i = 0; i < as.length; i++) if (as[i] !== bs[i]) return false;
  return true;
}
