// Before/after benchmark for the authoring silent-data-loss lint (P1).
//
// Validates that the newly-wired transform warnings actually CATCH the
// data-loss class they were meant to — and don't false-positive on clean
// reshapes. The "before" baseline is the shipped behaviour up to this change:
// the warning codes existed but NOTHING emitted them, so every lossy draft
// passed silently (recall = 0). The "after" column runs detectTransformWarnings.
//
// Run: bun run scripts/benchmark-authoring-lints.ts
//
// The corpus is labelled ground truth drawn from the two production failure
// shapes (Notion renderer returning "" for every block; format_output dropping
// `resources`) plus clean cases that MUST stay quiet.

import { detectTransformWarnings } from "../apps/engine/src/execution/steps/transform-warnings.ts";

type Expect = "transform_empty_extraction" | "transform_dropped_fields" | null;

interface Case {
  name: string;
  output: unknown;
  scope: Record<string, unknown>;
  expect: Expect; // ground truth: the warning that SHOULD fire, or null = clean
}

const env = (data: unknown) => ({ data });

const CORPUS: Case[] = [
  // ── Lossy: empty extraction (BLOCKING code) ──────────────────────────
  {
    name: "Notion renderer returns '' for every block",
    output: "",
    scope: { fetch_blocks: env([{ type: "toggle", has_children: true }, { type: "callout" }]) },
    expect: "transform_empty_extraction",
  },
  {
    name: "JSONata path typo → [] over non-empty list",
    output: [],
    scope: { list_projects: env([{ id: 1 }, { id: 2 }, { id: 3 }]) },
    expect: "transform_empty_extraction",
  },
  {
    name: "wrong key → {} over non-empty object",
    output: {},
    scope: { fetch_user: env({ id: 7, name: "ada" }) },
    expect: "transform_empty_extraction",
  },
  {
    name: "null return over non-empty upstream",
    output: null,
    scope: { fetch: env([{ a: 1 }]) },
    expect: "transform_empty_extraction",
  },
  // ── Lossy: dropped fields (INFORMATIONAL code) ───────────────────────
  {
    name: "format_output drops `resources` from mapped rows",
    output: [
      { project_id: 1, project_name: "a" },
      { project_id: 2, project_name: "b" },
    ],
    scope: {
      loop: env([
        { project_id: 1, project_name: "a", resources: [1, 2] },
        { project_id: 2, project_name: "b", resources: [3] },
      ]),
    },
    expect: "transform_dropped_fields",
  },
  {
    name: "projection drops two fields from a 3-item list",
    output: [{ id: 1 }, { id: 2 }, { id: 3 }],
    scope: {
      src: env([
        { id: 1, title: "x", status: "open" },
        { id: 2, title: "y", status: "open" },
        { id: 3, title: "z", status: "closed" },
      ]),
    },
    expect: "transform_dropped_fields",
  },
  // ── Clean: must stay quiet (precision) ───────────────────────────────
  {
    name: "legit full reshape, non-empty output",
    output: [{ id: 1, name: "a" }],
    scope: { list: env([{ id: 1, name: "a" }]) },
    expect: null,
  },
  {
    name: "intentional rename (keys not a subset) — not a drop",
    output: [{ slug: "a" }],
    scope: { src: env([{ id: 1, name: "a" }]) },
    expect: null,
  },
  {
    name: "aggregation collapses many rows to one summary object",
    output: { count: 3, total: 60 },
    scope: { rows: env([{ v: 10 }, { v: 20 }, { v: 30 }]) },
    expect: null,
  },
  {
    name: "empty output but upstream also empty (genuinely no data)",
    output: [],
    scope: { list: env([]) },
    expect: null,
  },
  {
    name: "ambiguous: two same-length sources → suppress (no false positive)",
    output: [{ a: 1 }],
    scope: { x: env([{ a: 1, b: 2 }]), y: env([{ a: 9, c: 3 }]) },
    expect: null,
  },
  {
    name: "different-length source → not the mapped array",
    output: [{ a: 1 }],
    scope: {
      src: env([
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ]),
    },
    expect: null,
  },
  {
    name: "passthrough keeps all keys",
    output: [{ a: 1, b: 2 }],
    scope: { src: env([{ a: 1, b: 2 }]) },
    expect: null,
  },
];

function firstCode(output: unknown, scope: Record<string, unknown>): Expect {
  const w = detectTransformWarnings({ step_id: "bench", output, scope });
  return (w[0]?.code as Expect) ?? null;
}

const lossy = CORPUS.filter((c) => c.expect !== null);
const clean = CORPUS.filter((c) => c.expect === null);

let afterCaught = 0;
let afterCorrectCode = 0;
let afterFalsePositives = 0;
const rows: string[] = [];

for (const c of CORPUS) {
  const got = firstCode(c.output, c.scope);
  const isLossy = c.expect !== null;
  const caught = got !== null;
  if (isLossy && caught) afterCaught++;
  if (isLossy && got === c.expect) afterCorrectCode++;
  if (!isLossy && caught) afterFalsePositives++;
  const before = "—"; // baseline emitted nothing, ever
  const verdict = isLossy
    ? got === c.expect
      ? "✓ caught"
      : caught
        ? "~ wrong code"
        : "✗ MISSED"
    : caught
      ? "✗ FALSE POS"
      : "✓ quiet";
  rows.push(
    `  ${verdict.padEnd(13)} before=${before.padEnd(3)} after=${(got ?? "quiet").padStart(26)}  ${c.name}`,
  );
}

const recallBefore = 0;
const recallAfter = (afterCaught / lossy.length) * 100;
const codeAccuracyAfter = (afterCorrectCode / lossy.length) * 100;
const precisionAfter = ((clean.length - afterFalsePositives) / clean.length) * 100;

console.log("\nAuthoring silent-data-loss lint — before/after benchmark");
console.log("=".repeat(72));
console.log(rows.join("\n"));
console.log("=".repeat(72));
console.log(`Corpus: ${CORPUS.length} cases (${lossy.length} lossy, ${clean.length} clean)\n`);
console.log("                          BEFORE (no emit)    AFTER (detector)");
console.log(
  `  Recall  (lossy caught)        ${recallBefore.toFixed(0)}%               ${recallAfter.toFixed(0)}%   (${afterCaught}/${lossy.length})`,
);
console.log(
  `  Correct warning code           —                ${codeAccuracyAfter.toFixed(0)}%   (${afterCorrectCode}/${lossy.length})`,
);
console.log(
  `  Precision (clean stayed quiet)  —                ${precisionAfter.toFixed(0)}%   (${clean.length - afterFalsePositives}/${clean.length})`,
);
console.log("");

const pass = recallAfter === 100 && codeAccuracyAfter === 100 && afterFalsePositives === 0;
if (pass) {
  console.log("VERDICT: ✓ improvement validated — every lossy draft is now caught with the");
  console.log("         right code, zero false positives. Before this change all were silent.\n");
  process.exit(0);
} else {
  console.log(
    `VERDICT: ✗ regression — recall ${recallAfter.toFixed(0)}%, code-accuracy ${codeAccuracyAfter.toFixed(0)}%, false-positives ${afterFalsePositives}.\n`,
  );
  process.exit(1);
}
