import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { PLATFORM_CATEGORY } from "../api/catalog-metadata.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import { type Db, getDb } from "../db/client.ts";
import { skills, tenants } from "../db/schema/index.ts";
import { retryTransient } from "../db/transient.ts";
import { withTenantWork } from "../execution/index.ts";
import { lockActiveTenant, SelfServiceIdentityError } from "../identity/index.ts";
import { EMBEDDED_SKILL_SEEDS } from "./embedded-seeds.ts";
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
  gates_tools: string[];
  activates_when: SkillActivation[];
  side_effects: SkillSideEffects;
  idempotency: SkillIdempotency;
  maturity: SkillMaturity;
  tags: string[];
  input_schema: Record<string, unknown> | null;
  output_schema: Record<string, unknown> | null;
  version: number;
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
  embedded_count: number;
}

export interface ApplyOutcome {
  tenant_id: string;
  inserted: number;
  updated: number;
  unchanged: number;
}

const LEGACY_KEYS = new Set(["auto_load", "trigger_keywords"]);

export interface SeedSource {
  file: string;
  content: string;
}

export function loadEmbeddedSkillSeeds(): LoadResult {
  return loadSkillSeedsFromContent(EMBEDDED_SKILL_SEEDS);
}

export function loadSkillSeedsFromContent(files: readonly SeedSource[]): LoadResult {
  const out: SeededSkill[] = [];
  const errors: ParseError[] = [];
  for (const entry of files) {
    const parsed = parseFrontmatter(entry.content, entry.file);
    if ("error" in parsed) {
      errors.push(parsed.error);
      continue;
    }
    out.push(parsed.skill);
  }
  return {
    skills: out,
    errors,
    embedded_count: files.length,
  };
}

export async function applySkillSeeds(
  seeds: SeededSkill[],
  tenant_id: string,
  db: Db = getDb(),
): Promise<ApplyOutcome> {
  return withTenantWork(tenant_id, () =>
    db.transaction(async (tx) => {
      await lockCatalogVocabulary(tx, tenant_id);
      await lockActiveTenant(tenant_id, tx);
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      for (const s of seeds) {
        const existing = await tx
          .select()
          .from(skills)
          .where(and(eq(skills.tenant_id, tenant_id), eq(skills.slug, s.slug)))
          .limit(1);
        const row = existing[0];
        if (!row) {
          await tx.insert(skills).values({
            tenant_id,
            slug: s.slug,
            scope: s.scope,
            title: s.title,
            description: s.description,
            description_source: "human",
            category: PLATFORM_CATEGORY,
            category_source: "human",
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
          if (row.description !== s.description || row.category !== PLATFORM_CATEGORY) {
            await tx
              .update(skills)
              .set({
                description: s.description,
                description_source: "human",
                category: PLATFORM_CATEGORY,
                category_source: "human",
              })
              .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, row.id)));
          }
          unchanged++;
          continue;
        }
        await tx
          .update(skills)
          .set({
            title: s.title,
            description: s.description,
            description_source: "human",
            category: PLATFORM_CATEGORY,
            category_source: "human",
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
    }),
  );
}

export async function applySkillSeedsForAllTenants(
  seeds: SeededSkill[],
  db: Db = getDb(),
): Promise<ApplyOutcome[]> {
  const allTenants = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.status, "active"), isNull(tenants.deleted_at)));
  const outcomes: ApplyOutcome[] = [];
  for (const t of allTenants) {
    try {
      const r = await retryTransient(() => applySkillSeeds(seeds, t.id, db), {
        label: "skills_seed",
      });
      outcomes.push(r);
    } catch (error) {
      if (!(error instanceof SelfServiceIdentityError) || error.code !== "tenant_unavailable")
        throw error;
    }
  }
  return outcomes;
}

type ParseOk = { skill: SeededSkill };
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
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (raw.startsWith("[{")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
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
