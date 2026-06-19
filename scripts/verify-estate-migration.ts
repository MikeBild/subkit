#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  EstateReplayManifestSchema,
  replayEstateManifest,
} from "../apps/engine/eval/estate-replay.ts";

interface CliArgs {
  manifest: string;
  out: string | null;
}

function usage(): never {
  console.error(
    [
      "Usage: bun run scripts/verify-estate-migration.ts --manifest <manifest.json> [--out report.json]",
      "",
      "The manifest contains old JSONata expressions, new JavaScript transforms,",
      "their exact runtime inputs, and optional held-write request snapshots.",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): CliArgs {
  let manifest = "";
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) usage();
      i += 1;
      return v;
    };
    if (arg === "--manifest") manifest = next();
    else if (arg === "--out") out = next();
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  if (!manifest) usage();
  return { manifest, out };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = EstateReplayManifestSchema.parse(
    JSON.parse(readFileSync(args.manifest, "utf8")),
  );
  const report = await replayEstateManifest(manifest);
  const out = args.out ?? join(dirname(args.manifest), "estate-migration-replay-report.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`estate replay: ${report.passed}/${report.total} passed`);
  for (const result of report.cases) {
    const status = result.passed ? "PASS" : "FAIL";
    console.log(
      `${status} ${result.id} output_equal=${result.output_equal} side_effects_equal=${
        result.side_effects_equal ?? "n/a"
      } old=${result.old_hash.slice(0, 12)} new=${result.new_hash.slice(0, 12)}`,
    );
    if (result.error) console.log(`  error: ${result.error}`);
  }
  if (report.failed > 0) process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
