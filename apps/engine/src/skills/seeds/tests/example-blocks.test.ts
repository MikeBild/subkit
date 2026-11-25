import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StepSchema } from "../../../workflows/types.ts";

const SKILLS_DIR = join(import.meta.dir, "..");
const KNOWN_KINDS = StepSchema.options.map(
  (s) => (("options" in s ? s.options[0] : s).shape.kind as { value: string }).value,
);

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
  for (const block of parseableBlocks) {
    test(`${block.file.replace(`${SKILLS_DIR}/`, "")}#${block.index} no \`config\` wrapper on step-shaped objects`, () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.body);
      } catch {
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
      const method = typeof obj.method === "string" ? obj.method : "GET";
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

const CONTROL_FLOW_KIND_PATTERN = /"kind"\s*:\s*"(branch|parallel)"/;
const STRUCTURES_SKILL_FILE = join(SKILLS_DIR, "workflow-authoring-structures.md");

function collectControlFlowSteps(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(collectControlFlowSteps);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const nested = Object.values(record).flatMap(collectControlFlowSteps);
  return record.kind === "branch" || record.kind === "parallel" ? [record, ...nested] : nested;
}

const parsedControlFlowSteps = parseableBlocks.flatMap((block) => {
  try {
    return collectControlFlowSteps(JSON.parse(block.body)).map((step) => ({ block, step }));
  } catch {
    return [];
  }
});

describe("seed/skills/*.md · branch and parallel examples match the engine contract", () => {
  test("the structures skill shows a parseable branch and a parseable parallel example", () => {
    const structuresKinds = parsedControlFlowSteps
      .filter(({ block }) => block.file === STRUCTURES_SKILL_FILE)
      .map(({ step }) => step.kind);
    expect(structuresKinds).toContain("branch");
    expect(structuresKinds).toContain("parallel");
  });

  for (const { block, step } of parsedControlFlowSteps) {
    test(`${block.file.replace(`${SKILLS_DIR}/`, "")}#${block.index} ${String(step.id)} parses with StepSchema`, () => {
      expect(StepSchema.safeParse(step).success).toBe(true);
    });
  }

  test("no json block wraps a branch or parallel step in a config object", () => {
    const offenders = allBlocks
      .filter(
        (block) => CONTROL_FLOW_KIND_PATTERN.test(block.body) && /"config"\s*:/.test(block.body),
      )
      .map((block) => `${block.file.replace(`${SKILLS_DIR}/`, "")}#${block.index}`);
    expect(offenders).toEqual([]);
  });

  test("the structures skill documents no multi-case branch or join keys", () => {
    const structuresBody = readFileSync(STRUCTURES_SKILL_FILE, "utf-8");
    expect(structuresBody).not.toContain('"cases"');
    expect(structuresBody).not.toMatch(/"default"\s*:\s*\[/);
    expect(structuresBody).not.toMatch(/"join"\s*:/);
  });
});
