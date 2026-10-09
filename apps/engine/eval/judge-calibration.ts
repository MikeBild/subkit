import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig, installRuntimeConfig, loadConfig } from "../src/config/loader.ts";
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
  output_schema?: Record<string, unknown>;
  label: "passes" | "partial" | "failed";
  note?: string;
}

function loadGolden(): GoldenCase[] {
  const path = join(import.meta.dir, "judge-golden.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { cases: GoldenCase[] };
  return parsed.cases;
}

function installAnthropicKeyFromEnv(): boolean {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return false;
  const base = getConfig();
  installRuntimeConfig({
    ...base,
    llm: {
      ...base.llm,
      provider: "anthropic",
      providers: {
        ...base.llm.providers,
        anthropic: { ...base.llm.providers.anthropic, api_key: key },
      },
    },
  });
  return true;
}

async function main(): Promise<void> {
  await loadConfig();
  installAnthropicKeyFromEnv();
  const setup = validateProviderSetup();
  if (setup.detected !== "anthropic" || !setup.ok) {
    console.error(
      `judge-calibration: needs a ready anthropic provider (real judge, not mock), got ` +
        `detected=${setup.detected} ok=${setup.ok} missing=${JSON.stringify(setup.missing)}. ` +
        `Pass the key through the environment of this one command (ANTHROPIC_API_KEY="$(cat key.txt)" bun run eval:judge) ` +
        `or point SUBKIT_CONFIG at a config with llm.provider=anthropic and llm.providers.anthropic.api_key.`,
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
          step_artifacts: [],
          final_output: c.final_output,
          output_schema: c.output_schema ?? null,
          tenant_id: tenant.id,
          db: testDb.db,
        });
        verdicts.push(outcome.verdict);
        if (outcome.verdict === c.label) exactHits += 1;
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
