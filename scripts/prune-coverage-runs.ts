import { resolve } from "node:path";
import { pruneExpiredCoverageRawRuns } from "../apps/engine/scripts/audit/coverage-retention.ts";

export function parsePruneCoverageRunsArgs(args: readonly string[]): boolean {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview")) return false;
  if (args.length === 1 && args[0] === "--apply") return true;
  throw new Error("usage: prune-coverage-runs.ts [--preview|--apply]");
}

if (import.meta.main) {
  const apply = parsePruneCoverageRunsArgs(process.argv.slice(2));
  const actions = pruneExpiredCoverageRawRuns(resolve(import.meta.dir, "../reports/coverage"), {
    apply,
  });
  for (const entry of actions)
    console.log(`${entry.action.toUpperCase()} ${entry.runId} ${entry.reason}`);
  console.log(
    `${apply ? "Applied" : "Previewed"} ${actions.filter((entry) => entry.action === "delete").length} raw coverage prune candidate(s)`,
  );
}
