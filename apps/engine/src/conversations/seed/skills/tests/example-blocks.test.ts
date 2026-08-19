// Foundation test for in-skill JSON examples.
//
// Every fenced ```json block in seed/skills/*.md teaches the LLM the
// canonical authoring shape. If the example drifts from the live Zod
// schema, the LLM faithfully copies the wrong shape and produces invalid
// drafts. Keeping examples literal avoids that failure mode; this test
// pins the contract.
//
// Two layers:
//
//  1. Parseability — every ```json block must be valid JSON (or be
//     marked illustrative via a placeholder pattern that signals
//     "this isn't meant to parse").
//
//  2. Shape lint — blocks that look like a workflow step (have `kind`)
//     or a workflow definition (have `steps`) must not use the
//     `config: {…}` wrapper that no schema in this repo defines, and
//     `kind` must be a member of the discriminated union.
//
// Full Zod validation is intentionally NOT applied because example IDs
// like `<digitalocean_connector_id>` are illustrative placeholders, not
// real UUIDs. Catching shape drift is what matters here; type-system
// pedantry would force every example to use real UUIDs and erode
// readability.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StepSchema } from "../../../../workflows/types.ts";

const SKILLS_DIR = join(import.meta.dir, "..");
const KNOWN_KINDS = StepSchema.options.map((s) => (s.shape.kind as { value: string }).value);

interface Block {
  file: string;
  index: number;
  body: string;
  isIllustrative: boolean;
}

function extractJsonBlocks(file: string, body: string): Block[] {
  const out: Block[] = [];
  const re = /```json\n([\s\S]*?)```/g;
  let idx = 0;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    const content = m[1] ?? "";
    out.push({
      file,
      index: idx++,
      body: content,
      // Heuristics for "this block is documentation, not a parseable
      // example". JS-style block comments, line comments, ellipsis
      // values, angle-bracketed placeholders (<anything>, <connector_id>),
      // or shell-style # comments inside the block all signal an
      // illustrative block that is not meant to round-trip JSON.parse.
      isIllustrative:
        /\/\*[\s\S]*?\*\//.test(content) ||
        /(^|\s)\/\/[^\n]*/.test(content) ||
        /(^|\s)#\s/.test(content) ||
        /\.{3}/.test(content) ||
        /<[a-z_][\w-]*>/i.test(content),
    });
  }
  return out;
}

function listSkillFiles(): string[] {
  return readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(SKILLS_DIR, f));
}

const allBlocks = listSkillFiles().flatMap((file) => {
  const body = readFileSync(file, "utf-8");
  return extractJsonBlocks(file, body);
});

const parseableBlocks = allBlocks.filter((b) => !b.isIllustrative);

describe("seed/skills/*.md · ```json blocks · parse", () => {
  test("at least one parseable block exists", () => {
    expect(parseableBlocks.length).toBeGreaterThan(0);
  });

  for (const block of parseableBlocks) {
    test(`${block.file.replace(`${SKILLS_DIR}/`, "")}#${block.index} parses as JSON`, () => {
      expect(() => JSON.parse(block.body)).not.toThrow();
    });
  }
});

describe("seed/skills/*.md · ```json blocks · shape lint", () => {
  // The `config: {…}` wrapper appears in older example blocks but no
  // schema in apps/engine/src/workflows/types.ts defines a `config`
  // field on a step. The LLM faithfully copies whatever shape the
  // examples use, so this lint rejects the wrapper outright.
  for (const block of parseableBlocks) {
    test(`${block.file.replace(`${SKILLS_DIR}/`, "")}#${block.index} no \`config\` wrapper on step-shaped objects`, () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.body);
      } catch {
        // parse-failure is caught by the prior describe block; skip.
        return;
      }
      const offenders: string[] = [];
      walk(parsed, "", offenders);
      if (offenders.length > 0) {
        throw new Error(
          `step-shaped object uses unknown \`config\` wrapper at: ${offenders.join(", ")}\n` +
            `Step fields belong directly on the object (kind, method, path, connector_id, …), not nested under config.`,
        );
      }
    });
  }

  for (const block of parseableBlocks) {
    test(`${block.file.replace(`${SKILLS_DIR}/`, "")}#${block.index} pagination uses canonical field names`, () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.body);
      } catch {
        return;
      }
      const offenders: string[] = [];
      lintPaginationDrift(parsed, "", offenders);
      if (offenders.length > 0) {
        throw new Error(
          `pagination uses non-canonical fields at: ${offenders.join(", ")}\n` +
            `Use \`strategy:\` (offset|page|cursor), \`page_size\`, \`offset_param\`, \`limit_param\`, \`page_param\`, \`start_page\`, \`cursor_request_param\`, \`cursor_response_path\`, or \`stop_when_empty_path\`.`,
        );
      }
    });
  }

  for (const block of parseableBlocks) {
    test(`${block.file.replace(`${SKILLS_DIR}/`, "")}#${block.index} no \`onError: { … }\` envelope (use \`on_error\` + retry fields)`, () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.body);
      } catch {
        return;
      }
      const offenders: string[] = [];
      lintOnErrorDrift(parsed, "", offenders);
      if (offenders.length > 0) {
        throw new Error(
          `nested \`onError\` envelope at: ${offenders.join(", ")}\n` +
            `Use \`on_error: "fail" | "continue"\` directly on the step, plus \`max_retries\`, \`retry_backoff_ms\`, \`retry_on_status\` at the same level.`,
        );
      }
    });
  }

  for (const block of parseableBlocks) {
    test(`${block.file.replace(`${SKILLS_DIR}/`, "")}#${block.index} \`sql\` block invariants`, () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.body);
      } catch {
        return;
      }
      const offenders: string[] = [];
      lintSqlBlocks(parsed, "", offenders);
      if (offenders.length > 0) {
        throw new Error(
          `sql block invariants violated at: ${offenders.join(", ")}\n` +
            `Every \`sql:\` block needs \`query\`. Use \`sql.params\` for variable values; never interpolate \${input.…} into the query string.`,
        );
      }
    });
  }

  for (const block of parseableBlocks) {
    test(`${block.file.replace(`${SKILLS_DIR}/`, "")}#${block.index} \`s3\` block invariants`, () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.body);
      } catch {
        return;
      }
      const offenders: string[] = [];
      lintS3Blocks(parsed, "", offenders);
      if (offenders.length > 0) {
        throw new Error(
          `s3 block invariants violated at: ${offenders.join(", ")}\n` +
            `LIST needs \`prefix\`; GET/PUT/HEAD/DELETE need \`key\` (or step.path).`,
        );
      }
    });
  }

  for (const block of parseableBlocks) {
    test(`${block.file.replace(`${SKILLS_DIR}/`, "")}#${block.index} no \`output_transform\` + \`output_transform_function\` mix on the same workflow`, () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.body);
      } catch {
        return;
      }
      const offenders: string[] = [];
      lintOutputTransformMix(parsed, "", offenders);
      if (offenders.length > 0) {
        throw new Error(
          `workflow sets both output_transform and output_transform_function at: ${offenders.join(", ")}\n` +
            `Pick one: \`output_transform\` (JSONata) OR \`output_transform_function\` (JS). The Zod schema rejects both at authoring time.`,
        );
      }
    });
  }

  for (const block of parseableBlocks) {
    test(`${block.file.replace(`${SKILLS_DIR}/`, "")}#${block.index} no cross-driver expectation mix (\`expected_statuses\` + \`expected_row_count\`)`, () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.body);
      } catch {
        return;
      }
      const offenders: string[] = [];
      lintCrossDriverExpectations(parsed, "", offenders);
      if (offenders.length > 0) {
        throw new Error(
          `step sets both expected_statuses and expected_row_count at: ${offenders.join(", ")}\n` +
            `expected_statuses is HTTP/S3 only; expected_row_count is postgres-only. Pick one based on the driver.`,
        );
      }
    });
  }

  for (const block of parseableBlocks) {
    test(`${block.file.replace(`${SKILLS_DIR}/`, "")}#${block.index} \`kind\` (when present) is a known step kind`, () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.body);
      } catch {
        return;
      }
      const offenders: string[] = [];
      collectKinds(parsed, "", offenders);
      if (offenders.length > 0) {
        throw new Error(
          `unknown \`kind\` value at: ${offenders.join(", ")}.\n` +
            `Known kinds: ${KNOWN_KINDS.join(", ")}`,
        );
      }
    });
  }
});

function walk(value: unknown, path: string, offenders: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      walk(v, `${path}[${i}]`, offenders);
    });
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("kind" in obj && "config" in obj) {
      offenders.push(path || "(root)");
    }
    for (const [k, v] of Object.entries(obj)) {
      walk(v, path ? `${path}.${k}` : k, offenders);
    }
  }
}

/**
 * Lint pagination drift: the real PaginationSchema uses `strategy:`
 * (offset/page/cursor) plus the schema-canonical field names. Older
 * skill examples used `mode:` + `total_path` /
 * `cursor_param` / `cursor_path` / `page_size_param` / `has_more_path`,
 * none of which exist on the type. Surface those so the drift fix
 * doesn't silently regress.
 */
const PAGINATION_DRIFT_FIELDS = new Set([
  "mode",
  "total_path",
  "cursor_param",
  "cursor_path",
  "page_size_param",
  "has_more_path",
]);

function lintPaginationDrift(value: unknown, path: string, offenders: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      lintPaginationDrift(v, `${path}[${i}]`, offenders);
    });
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (path.endsWith("pagination") || path.endsWith(".pagination")) {
      for (const k of Object.keys(obj)) {
        if (PAGINATION_DRIFT_FIELDS.has(k)) {
          offenders.push(`${path}.${k}`);
        }
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      lintPaginationDrift(v, path ? `${path}.${k}` : k, offenders);
    }
  }
}

/**
 * Lint `onError: { mode: ... }` drift. The real schema is
 * `on_error: "fail" | "continue"` directly on the step, with retry
 * fields (`max_retries`, `retry_backoff_ms`, `retry_on_status`) at
 * the same level. The nested `onError` envelope never existed.
 */
/**
 * Lint sql block: must declare `query`. Variable interpolation into
 * the query string is the SQL-injection hatch the doc explicitly
 * forbids — flag any `${…}` substring inside `sql.query`.
 */
function lintSqlBlocks(value: unknown, path: string, offenders: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      lintSqlBlocks(v, `${path}[${i}]`, offenders);
    });
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (
      "sql" in obj &&
      typeof obj.sql === "object" &&
      obj.sql !== null &&
      !Array.isArray(obj.sql)
    ) {
      const sql = obj.sql as Record<string, unknown>;
      if (typeof sql.query !== "string" || sql.query.length === 0) {
        offenders.push(`${path}.sql.query (missing or empty)`);
      } else if (/\$\{[^}]+\}/.test(sql.query)) {
        offenders.push(
          `${path}.sql.query contains \${…} interpolation — move that value to sql.params`,
        );
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      lintSqlBlocks(v, path ? `${path}.${k}` : k, offenders);
    }
  }
}

/**
 * Lint s3 block: LIST needs `prefix`; the other verbs need `key` (or
 * `step.path`). The runtime superRefine catches this too, but the
 * lint runs against documentation examples where Zod isn't applied.
 */
function lintS3Blocks(value: unknown, path: string, offenders: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      lintS3Blocks(v, `${path}[${i}]`, offenders);
    });
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("s3" in obj && typeof obj.s3 === "object" && obj.s3 !== null && !Array.isArray(obj.s3)) {
      const s3 = obj.s3 as Record<string, unknown>;
      // step.method is the single source of truth; s3.method was
      // removed.
      const method = typeof obj.method === "string" ? obj.method : "GET";
      // Reject legacy `s3.method` so old skill examples can't drift
      // back in.
      if ("method" in s3) {
        offenders.push(`${path}.s3.method (use step.method instead)`);
      }
      if (method === "LIST") {
        if (typeof s3.prefix !== "string" || s3.prefix.length === 0) {
          offenders.push(`${path}.s3 (LIST requires prefix)`);
        }
      } else if (method === "GET" || method === "PUT" || method === "HEAD" || method === "DELETE") {
        const hasKey = typeof s3.key === "string" && s3.key.length > 0;
        const hasPath = typeof obj.path === "string" && (obj.path as string).length > 0;
        if (!hasKey && !hasPath) {
          offenders.push(`${path}.s3 (${method} requires key or step.path)`);
        }
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      lintS3Blocks(v, path ? `${path}.${k}` : k, offenders);
    }
  }
}

/**
 * Cross-driver lint: `expected_statuses` and `expected_row_count`
 * are dispatch-mutually-exclusive (HTTP/S3 vs Postgres). The
 * superRefine rejects this at runtime; the lint catches doc drift
 * before it hits the schema.
 */
/**
 * `output_transform` (JSONata) and `output_transform_function` (JS)
 * are mutually exclusive at authoring time. Catch examples that set
 * both before the schema does — keeps doc samples consistent with
 * the runtime contract.
 */
function lintOutputTransformMix(value: unknown, path: string, offenders: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      lintOutputTransformMix(v, `${path}[${i}]`, offenders);
    });
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("output_transform" in obj && "output_transform_function" in obj) {
      offenders.push(path || "(root)");
    }
    for (const [k, v] of Object.entries(obj)) {
      lintOutputTransformMix(v, path ? `${path}.${k}` : k, offenders);
    }
  }
}

function lintCrossDriverExpectations(value: unknown, path: string, offenders: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      lintCrossDriverExpectations(v, `${path}[${i}]`, offenders);
    });
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("expected_statuses" in obj && "expected_row_count" in obj) {
      offenders.push(path || "(root)");
    }
    for (const [k, v] of Object.entries(obj)) {
      lintCrossDriverExpectations(v, path ? `${path}.${k}` : k, offenders);
    }
  }
}

function lintOnErrorDrift(value: unknown, path: string, offenders: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      lintOnErrorDrift(v, `${path}[${i}]`, offenders);
    });
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("onError" in obj && typeof obj.onError === "object") {
      offenders.push(path || "(root)");
    }
    for (const [k, v] of Object.entries(obj)) {
      lintOnErrorDrift(v, path ? `${path}.${k}` : k, offenders);
    }
  }
}

function collectKinds(value: unknown, path: string, offenders: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      collectKinds(v, `${path}[${i}]`, offenders);
    });
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("kind" in obj && typeof obj.kind === "string") {
      if (!KNOWN_KINDS.includes(obj.kind)) {
        offenders.push(`${path || "(root)"} (kind="${obj.kind}")`);
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      collectKinds(v, path ? `${path}.${k}` : k, offenders);
    }
  }
}
