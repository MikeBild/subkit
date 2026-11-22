import { resolve } from "node:path";
import { pruneMutationReports } from "../apps/engine/scripts/audit/mutation-retention.ts";

export function parsePruneMutationRunsArgs(args: readonly string[]): boolean {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview")) return false;
  if (args.length === 1 && args[0] === "--apply") return true;
  throw new Error("usage: prune-mutation-runs.ts [--preview|--apply]");
}

if (import.meta.main) {
  const apply = parsePruneMutationRunsArgs(process.argv.slice(2));
  const plan = pruneMutationReports(resolve(import.meta.dir, "../.reports"), { apply });
  for (const wave of plan.waves) console.log(`DELETE mutation/runs/${wave}`);
  for (const ref of plan.runs) console.log(`DELETE mutation/runs/${ref.wave}/${ref.run}`);
  for (const wave of plan.inputs) console.log(`DELETE quality-inputs/${wave}`);
  console.log(
    `${apply ? "Applied" : "Previewed"} ${plan.waves.length + plan.runs.length + plan.inputs.length} mutation report prune candidate(s); release receipts are never pruned`,
  );
}
