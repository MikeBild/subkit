// Disk-backed skill seeding.
//
// Reads Markdown files from `apps/engine/src/conversations/seed/skills/*.md`,
// parses a minimal YAML front-matter block (only the keys we actually use,
// so we don't take a dependency on `gray-matter`), and upserts each file as
// a row in the `skills` table per tenant.
//
// Upsert strategy: `(tenant_id, slug)` is unique when slug is non-null. We
// look up an existing row by that pair; if the SHA-256 content-hash of the
// current body differs from the stored body, we UPDATE (bumping `version`).
// Otherwise we skip.
//
// Per-tenant overrides live in `tenant_skill_overrides`. Seed rows are never
// overwritten by operators directly — an operator who wants to override
// inserts/updates a `tenant_skill_overrides` row with `hidden=true` or a
// `body_override`. That keeps the seed channel clean and patchable.
//
// Front-matter contract (migration 0006 — replaces the legacy `gates_tools`
// / `auto_load` / `trigger_keywords` trio):
//
//     ---
//     slug: foo
//     scope: global
//     title: Foo
//     description: One-liner.
//     activates_when: [{"kind":"baseline"},{"kind":"tool","tool":"probe_connector"}]
//     side_effects: read              # default: read
//     idempotency: none               # default: none
//     maturity: stable                # default: stable
//     tags: [stripe, payments]        # default: []
//     input_schema: {"type":"object","properties":{...}}    # optional JSONSchema
//     output_schema: {"type":"object","properties":{...}}   # optional JSONSchema
//     version: 1
//     ---
//     <markdown body>

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { type Db, getDb } from "../db/client.ts";
import { skills, tenants } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import {
  type SkillActivation,
  SkillActivationSchema,
  type SkillIdempotency,
  SkillIdempotencySchema,
  type SkillMaturity,
  SkillMaturitySchema,
  type SkillSideEffects,
  SkillSideEffectsSchema,
} from "./types.ts";

export interface SeededSkill {
  slug: string;
  scope: "global" | "connector" | "workflow";
  title: string;
  description: string;
  body: string;
  /** Tools that become invisible to the LLM until this skill loads —
   *  consumed by `conversations/tools/gated.ts`. */
  gates_tools: string[];
  activates_when: SkillActivation[];
  side_effects: SkillSideEffects;
  idempotency: SkillIdempotency;
  maturity: SkillMaturity;
  tags: string[];
  input_schema: Record<string, unknown> | null;
  output_schema: Record<string, unknown> | null;
  version: number;
  /** sha256 of body; used to detect drift without re-writing the row. */
  body_hash: string;
}

export interface ParseError {
  file: string;
  code:
    | "missing_frontmatter"
    | "missing_key"
    | "bad_yaml"
    | "bad_scope"
    | "bad_activates_when"
    | "bad_side_effects"
    | "bad_idempotency"
    | "bad_maturity"
    | "bad_schema"
    | "legacy_field";
  message: string;
}

export interface LoadResult {
  skills: SeededSkill[];
  errors: ParseError[];
  resolved_dir: string | null;
  searched_dirs: string[];
  missing_dirs: string[];
}

export interface ApplyOutcome {
  tenant_id: string;
  inserted: number;
  updated: number;
  unchanged: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SEED_DIR = path.resolve(
  process.cwd(),
  "apps",
  "engine",
  "src",
  "conversations",
  "seed",
  "skills",
);
export const DEFAULT_RUNTIME_SEED_DIR = path.resolve(
  path.dirname(process.execPath),
  "..",
  "share",
  "subkit",
  "skills",
);
const BUNDLE_FALLBACK_SEED_DIR = path.resolve(HERE, "..", "conversations", "seed", "skills");

// Front-matter keys removed in migration 0006. A seed file that still
// carries any of these fails parse with a typed `legacy_field` error so
// operators discover the rename loudly during the next boot.
// `gates_tools` is NOT in this set — it is the inverse of activation
// (which tools are invisible until the skill loads) and remains a
// first-class field on every skill row.
const LEGACY_KEYS = new Set(["auto_load", "trigger_keywords"]);

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      paths.filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];
}

export function resolveSkillSeedDirCandidates(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  execPath: string = process.execPath,
): string[] {
  return uniquePaths([
    env.SK_SEED_SKILLS_DIR,
    path.resolve(cwd, "apps", "engine", "src", "conversations", "seed", "skills"),
    path.resolve(path.dirname(execPath), "..", "share", "subkit", "skills"),
    BUNDLE_FALLBACK_SEED_DIR,
  ]);
}

async function resolveSeedDir(candidates: string[]): Promise<{
  resolved_dir: string | null;
  searched_dirs: string[];
  missing_dirs: string[];
}> {
  const missing_dirs: string[] = [];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return {
          resolved_dir: candidate,
          searched_dirs: candidates,
          missing_dirs,
        };
      }
      missing_dirs.push(candidate);
    } catch {
      missing_dirs.push(candidate);
    }
  }
  return {
    resolved_dir: null,
    searched_dirs: candidates,
    missing_dirs,
  };
}

export async function loadSkillSeedsFromDisk(dir?: string): Promise<LoadResult> {
  const out: SeededSkill[] = [];
  const errors: ParseError[] = [];
  const searched_dirs = dir ? [dir] : resolveSkillSeedDirCandidates();
  const resolved = await resolveSeedDir(searched_dirs);
  if (!resolved.resolved_dir) {
    logger.info({
      module: "skills.seed",
      action: "seed_dir_missing",
      dir: dir ?? null,
      searched_dirs: resolved.searched_dirs,
      missing_dirs: resolved.missing_dirs,
      msg: "skill seed directory does not exist; skipping",
    });
    return {
      skills: [],
      errors: [],
      resolved_dir: null,
      searched_dirs: resolved.searched_dirs,
      missing_dirs: resolved.missing_dirs,
    };
  }
  const entries = await fs.readdir(resolved.resolved_dir);
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    if (name.toLowerCase() === "readme.md") continue;
    const file = path.join(resolved.resolved_dir, name);
    const raw = await fs.readFile(file, "utf8");
    const parsed = parseFrontmatter(raw, file);
    if ("error" in parsed) {
      errors.push(parsed.error);
      continue;
    }
    out.push(parsed.skill);
  }
  return {
    skills: out,
    errors,
    resolved_dir: resolved.resolved_dir,
    searched_dirs: resolved.searched_dirs,
    missing_dirs: resolved.missing_dirs,
  };
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
        activates_when: s.activates_when,
        input_schema: s.input_schema,
        output_schema: s.output_schema,
        side_effects: s.side_effects,
        idempotency: s.idempotency,
        maturity: s.maturity,
        tags: s.tags,
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
      row.side_effects === s.side_effects &&
      row.idempotency === s.idempotency &&
      row.maturity === s.maturity &&
      sameStringArray(row.gates_tools, s.gates_tools) &&
      sameUnknownArray(row.activates_when, s.activates_when) &&
      sameStringArray(row.tags, s.tags) &&
      sameRecord(row.input_schema, s.input_schema) &&
      sameRecord(row.output_schema, s.output_schema)
    ) {
      unchanged++;
      continue;
    }
    await db
      .update(skills)
      .set({
        title: s.title,
        body: s.body,
        seed_source: s.body_hash,
        gates_tools: s.gates_tools,
        activates_when: s.activates_when,
        input_schema: s.input_schema,
        output_schema: s.output_schema,
        side_effects: s.side_effects,
        idempotency: s.idempotency,
        maturity: s.maturity,
        tags: s.tags,
        version: Math.max(row.version + 1, s.version),
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
  // Front-matter contract: see header docstring. Hand-written parser over
  // a narrow subset of YAML — accepts single-line scalars, flow arrays
  // `[a, b]`, and inline JSON `{...}` / `[{...}]` for fields that need
  // structured shapes (`activates_when`, `input_schema`, `output_schema`).
  // Multi-line values, nested block-style maps, anchors, and references
  // are intentionally rejected; their parsing-attack surface isn't worth
  // the dependency on a full YAML library.
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
    if (LEGACY_KEYS.has(key)) {
      return {
        error: {
          file,
          code: "legacy_field",
          message: `frontmatter key '${key}' was removed in migration 0006; express the intent via 'activates_when' instead`,
        },
      };
    }
    const rest = line.slice(idx + 1).trim();
    fm[key] = parseScalar(rest);
  }

  const slug = String(fm.slug ?? "");
  const scope = String(fm.scope ?? "");
  const title = String(fm.title ?? "");
  const description = String(fm.description ?? "");
  const version = typeof fm.version === "number" ? fm.version : 1;

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

  const activates_when_raw = fm.activates_when ?? [];
  if (!Array.isArray(activates_when_raw)) {
    return {
      error: {
        file,
        code: "bad_activates_when",
        message: `expected array, got ${JSON.stringify(activates_when_raw)}`,
      },
    };
  }
  const parsed = z_array_parse(activates_when_raw);
  if (!parsed.ok) {
    return { error: { file, code: "bad_activates_when", message: parsed.message } };
  }

  const side_effects_raw = fm.side_effects ?? "read";
  const sideRes = SkillSideEffectsSchema.safeParse(side_effects_raw);
  if (!sideRes.success) {
    return {
      error: {
        file,
        code: "bad_side_effects",
        message: `invalid side_effects '${String(side_effects_raw)}'`,
      },
    };
  }

  const idempotency_raw = fm.idempotency ?? "none";
  const idemRes = SkillIdempotencySchema.safeParse(idempotency_raw);
  if (!idemRes.success) {
    return {
      error: {
        file,
        code: "bad_idempotency",
        message: `invalid idempotency '${String(idempotency_raw)}'`,
      },
    };
  }

  const maturity_raw = fm.maturity ?? "stable";
  const matRes = SkillMaturitySchema.safeParse(maturity_raw);
  if (!matRes.success) {
    return {
      error: {
        file,
        code: "bad_maturity",
        message: `invalid maturity '${String(maturity_raw)}'`,
      },
    };
  }

  const tags = Array.isArray(fm.tags) ? fm.tags.map((v) => String(v)) : [];
  const gates_tools = Array.isArray(fm.gates_tools) ? fm.gates_tools.map((v) => String(v)) : [];

  const input_schema = parseSchemaField(fm.input_schema, "input_schema", file);
  if ("error" in input_schema) return input_schema;
  const output_schema = parseSchemaField(fm.output_schema, "output_schema", file);
  if ("error" in output_schema) return output_schema;

  const body_hash = createHash("sha256").update(body).digest("hex");
  return {
    skill: {
      slug,
      scope,
      title,
      description,
      body,
      gates_tools,
      activates_when: parsed.value,
      side_effects: sideRes.data,
      idempotency: idemRes.data,
      maturity: matRes.data,
      tags,
      input_schema: input_schema.value,
      output_schema: output_schema.value,
      version,
      body_hash,
    },
  };
}

function parseSchemaField(
  value: unknown,
  key: string,
  file: string,
): { value: Record<string, unknown> | null } | ParseFail {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value === "object" && !Array.isArray(value)) {
    return { value: value as Record<string, unknown> };
  }
  return {
    error: {
      file,
      code: "bad_schema",
      message: `${key} must be a JSON object literal (got: ${JSON.stringify(value)})`,
    },
  };
}

function z_array_parse(
  raw: unknown[],
): { ok: true; value: SkillActivation[] } | { ok: false; message: string } {
  const out: SkillActivation[] = [];
  for (let i = 0; i < raw.length; i++) {
    const result = SkillActivationSchema.safeParse(raw[i]);
    if (!result.success) {
      return {
        ok: false,
        message: `activates_when[${i}] invalid: ${result.error.issues
          .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
          .join("; ")}`,
      };
    }
    out.push(result.data);
  }
  return { ok: true, value: out };
}

function parseScalar(raw: string): unknown {
  if (raw === "") return "";
  // Quoted string:
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // JSON object literal — used for input_schema / output_schema and any
  // nested map. Detected by `{...}` envelope.
  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      return JSON.parse(raw);
    } catch {
      // fall through to literal-string return so the caller can decide
      // whether the field needed to be JSON.
      return raw;
    }
  }
  // JSON array of objects — used for activates_when. Detected by `[{...`
  // prefix; falls back to flow-array when the inner items are scalars.
  if (raw.startsWith("[{")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
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
  // Number:
  const n = Number(raw);
  if (!Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(raw)) return n;
  // Boolean:
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function sameStringArray(a: unknown, b: string[]): boolean {
  if (!Array.isArray(a)) return false;
  if (a.length !== b.length) return false;
  const as = [...(a as string[])].sort();
  const bs = [...b].sort();
  for (let i = 0; i < as.length; i++) if (as[i] !== bs[i]) return false;
  return true;
}

function sameUnknownArray(a: unknown, b: unknown[]): boolean {
  if (!Array.isArray(a)) return false;
  if (a.length !== b.length) return false;
  // Activation rules are small JSON objects; stable JSON.stringify is the
  // simplest correct comparator without taking on a deep-equal dep.
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}

function sameRecord(a: unknown, b: Record<string, unknown> | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
