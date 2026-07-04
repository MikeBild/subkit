// Judge-calibration runner.
//
// The preview judge (`conversations/preview-judge.ts`) is an LLM gate: it
// decides whether a previewed workflow output satisfies the user's goal. It had
// LOGIC tests but no CALIBRATION — no check that its verdicts agree with human
// judgment. A miscalibrated judge silently passes bad workflows (or blocks good
// ones), so this runner measures agreement against a human-labeled golden set
// (`eval/judge-golden.json`) and FAILS if agreement drops below the threshold.
//
//   MASTER_KEY=<64hex> SK_OVERRIDE_LLM_PROVIDER=anthropic \
//     SK_OVERRIDE_LLM_PROVIDERS_ANTHROPIC_API_KEY=sk-ant-... \
//     bun run apps/engine/eval/judge-calibration.ts
//
// Needs Postgres (a throwaway migrated DB) + a real LLM key — it exercises the
// REAL judge, not the mock. NOT part of the mock-only `bun run eval` gate; runs
// pre-release / nightly (see .github/workflows/nightly-eval.yml). Exit 0 when
// agreement >= AGREEMENT_THRESHOLD, else 1.

// The LLM provider + key come from the same SK_OVERRIDE_* env the engine reads
// (see the usage line above). This runner exercises the real judge WITHOUT
// booting the engine, so main() must `await loadConfig()` itself — until it does,
// the config is uninitialised and the judge silently resolves to the `gateway`
// provider (every verdict `skipped`, a bogus 0% agreement).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/loader.ts";
import { judgePreview } from "../src/conversations/preview-judge.ts";
import { tenants } from "../src/db/schema/index.ts";
import { createTestDb } from "../src/db/tests/setup.ts";
import { validateProviderSetup } from "../src/llm/core/model-init.ts";

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
  // Initialise config the way the engine boot does, then require a ready
  // anthropic provider — a misconfig fails fast here instead of silently
  // resolving to `gateway` and reporting a bogus 0% agreement.
  await loadConfig();
  const setup = validateProviderSetup();
  if (setup.detected !== "anthropic" || !setup.ok) {
    console.error(
      `judge-calibration: needs a ready anthropic provider (real judge, not mock), got ` +
        `detected=${setup.detected} ok=${setup.ok} missing=${JSON.stringify(setup.missing)}. ` +
        `Set SK_OVERRIDE_LLM_PROVIDER=anthropic + SK_OVERRIDE_LLM_PROVIDERS_ANTHROPIC_API_KEY.`,
    );
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

    // Multi-trial: the judge is stochastic, so a single trial near the
    // threshold flips the verdict run-to-run. Run N trials per case and gate on
    // the POOLED mean agreement (more samples → smaller standard error). We
    // deliberately do NOT gate on per-case unanimity: requiring every trial to
    // agree is far stricter than the 80% threshold and would itself flake the
    // gate. The weakest-case rate is surfaced so a single bimodal case a pooled
    // mean could mask is still visible.
    const TRIALS = Math.max(1, Number(process.env.TRIALS ?? "3"));
    const totalTrials = cases.length * TRIALS;
    let exactHits = 0;
    let lenientHits = 0;
    const rows: Array<{ name: string; label: string; verdicts: string[]; lenient: number }> = [];
    console.log(`judge-calibration · ${cases.length} golden cases × ${TRIALS} trial(s)\n`);
    for (const c of cases) {
      const verdicts: string[] = [];
      let caseLenient = 0;
      for (let t = 0; t < TRIALS; t += 1) {
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
        verdicts.push(outcome.verdict);
        if (outcome.verdict === c.label) exactHits += 1;
        // Lenient: collapse to a binary "did it satisfy the goal?" (passes vs not).
        if ((outcome.verdict === "passes") === (c.label === "passes")) {
          lenientHits += 1;
          caseLenient += 1;
        }
      }
      rows.push({ name: c.name, label: c.label, verdicts, lenient: caseLenient });
      const mark = caseLenient === TRIALS ? "✓" : caseLenient > 0 ? "~" : "✗";
      const dist = TRIALS > 1 ? `  lenient=${caseLenient}/${TRIALS}` : "";
      console.log(
        `  ${mark} ${c.name.padEnd(34)} label=${c.label.padEnd(7)} judge=${verdicts[0]}${dist}`,
      );
    }

    const exactRate = exactHits / totalTrials;
    const lenientRate = lenientHits / totalTrials;
    const weakestCase = Math.min(...rows.map((r) => r.lenient / TRIALS));
    console.log(
      `\nagreement (exact, pooled):   ${(exactRate * 100).toFixed(1)}%  (${exactHits}/${totalTrials})`,
    );
    console.log(
      `agreement (lenient, pooled): ${(lenientRate * 100).toFixed(1)}%  (${lenientHits}/${totalTrials})`,
    );
    console.log(`weakest case (lenient):      ${(weakestCase * 100).toFixed(1)}%`);
    console.log(`threshold: ${(AGREEMENT_THRESHOLD * 100).toFixed(0)}% (lenient, pooled)\n`);

    if (lenientRate < AGREEMENT_THRESHOLD) {
      console.error(
        `JUDGE CALIBRATION FAILED — pooled lenient agreement ${(lenientRate * 100).toFixed(1)}% < ${(
          AGREEMENT_THRESHOLD * 100
        ).toFixed(0)}%. Disagreements:`,
      );
      for (const r of rows.filter((r) => r.lenient < TRIALS)) {
        console.error(
          `  ${r.name}: labeled ${r.label}, judged ${r.verdicts.join("/")} (lenient ${r.lenient}/${TRIALS})`,
        );
      }
      process.exit(1);
    }
    console.log("JUDGE CALIBRATION PASSED.");
  } finally {
    await testDb.cleanup();
  }
}

await main();
