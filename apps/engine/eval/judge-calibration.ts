// Judge-calibration runner.
//
// The preview judge (`conversations/preview-judge.ts`) is an LLM gate: it
// decides whether a previewed workflow output satisfies the user's goal. It had
// LOGIC tests but no CALIBRATION — no check that its verdicts agree with human
// judgment. A miscalibrated judge silently passes bad workflows (or blocks good
// ones), so this runner measures agreement against a human-labeled golden set
// (`eval/judge-golden.json`) and FAILS if agreement drops below the threshold.
//
//   MASTER_KEY=<64hex> ANTHROPIC_API_KEY=sk-ant-... \
//     bun run apps/engine/eval/judge-calibration.ts
//
// Needs Postgres (a throwaway migrated DB) + a real LLM key — it exercises the
// REAL judge, not the mock. NOT part of the mock-only `bun run eval` gate; runs
// pre-release / nightly (see .github/workflows/nightly-eval.yml). Exit 0 when
// agreement >= AGREEMENT_THRESHOLD, else 1.

// Config overrides MUST be set before any import that reads getConfig().
process.env.SK_OVERRIDE_LLM_PROVIDER = "anthropic";
if (process.env.ANTHROPIC_API_KEY) {
  process.env.SK_OVERRIDE_LLM_API_KEY = process.env.ANTHROPIC_API_KEY;
}
process.env.SK_OVERRIDE_LLM_MODEL ??= "claude-sonnet-4-6";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgePreview } from "../src/conversations/preview-judge.ts";
import { tenants } from "../src/db/schema/index.ts";
import { createTestDb } from "../src/db/tests/setup.ts";

const AGREEMENT_THRESHOLD = 0.8;

interface GoldenCase {
  name: string;
  goal: string;
  definition_summary: string;
  final_output: unknown;
  label: "passes" | "partial" | "failed";
  note?: string;
}

function loadGolden(): GoldenCase[] {
  const path = join(import.meta.dir, "judge-golden.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { cases: GoldenCase[] };
  return parsed.cases;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("judge-calibration: ANTHROPIC_API_KEY is required (real judge, not mock).");
    process.exit(2);
  }
  const cases = loadGolden();
  const testDb = await createTestDb("judge-calibration");
  try {
    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "judge-cal", display_name: "Judge Calibration" })
      .returning();
    if (!tenant) throw new Error("seed tenant failed");

    let agree = 0;
    let lenientAgree = 0;
    const rows: Array<{ name: string; label: string; verdict: string; ok: boolean }> = [];
    console.log(`judge-calibration · ${cases.length} golden cases\n`);
    for (const c of cases) {
      const outcome = await judgePreview({
        goal: c.goal,
        definition_summary: c.definition_summary,
        // The LLM judge reads step_artifacts (the rendered step outputs). In the
        // real gate the final step's output_preview carries the content; mirror
        // that so the judge actually sees the output it is meant to grade
        // (passing [] would test the judge against an empty preview).
        step_artifacts: [
          {
            step_id: "output",
            kind: "transform",
            status: "succeeded",
            output_preview: c.final_output,
          },
        ],
        final_output: c.final_output,
        tenant_id: tenant.id,
        db: testDb.db,
      });
      const verdict = outcome.verdict;
      const exact = verdict === c.label;
      // Lenient: collapse to a binary "did it satisfy the goal?" (passes vs not).
      const lenient = (verdict === "passes") === (c.label === "passes");
      if (exact) agree += 1;
      if (lenient) lenientAgree += 1;
      rows.push({ name: c.name, label: c.label, verdict, ok: exact });
      console.log(
        `  ${exact ? "✓" : "✗"} ${c.name.padEnd(34)} label=${c.label.padEnd(7)} judge=${verdict}`,
      );
    }

    const exactRate = agree / cases.length;
    const lenientRate = lenientAgree / cases.length;
    console.log(
      `\nagreement (exact):   ${(exactRate * 100).toFixed(1)}%  (${agree}/${cases.length})`,
    );
    console.log(
      `agreement (lenient): ${(lenientRate * 100).toFixed(1)}%  (${lenientAgree}/${cases.length})`,
    );
    console.log(`threshold: ${(AGREEMENT_THRESHOLD * 100).toFixed(0)}% (lenient)\n`);

    if (lenientRate < AGREEMENT_THRESHOLD) {
      console.error(
        `JUDGE CALIBRATION FAILED — lenient agreement ${(lenientRate * 100).toFixed(1)}% < ${(
          AGREEMENT_THRESHOLD * 100
        ).toFixed(0)}%. Disagreements:`,
      );
      for (const r of rows.filter((r) => !r.ok)) {
        console.error(`  ${r.name}: labeled ${r.label}, judged ${r.verdict}`);
      }
      process.exit(1);
    }
    console.log("JUDGE CALIBRATION PASSED.");
  } finally {
    await testDb.cleanup();
  }
}

await main();
