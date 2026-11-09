import { pruneVerificationRuns, verificationRunsRoot } from "./lib/verification-run-lifecycle.ts";

export function parsePruneVerificationRunsArgs(args: readonly string[]): { apply: boolean } {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview")) return { apply: false };
  if (args.length === 1 && args[0] === "--apply") return { apply: true };
  throw new Error("usage: bun run scripts/prune-verification-runs.ts [--preview|--apply]");
}

if (import.meta.main) {
  const { apply } = parsePruneVerificationRunsArgs(process.argv.slice(2));
  const candidates = pruneVerificationRuns(verificationRunsRoot(process.cwd()), { apply });
  for (const candidate of candidates)
    process.stdout.write(
      `${apply && candidate.action === "remove" ? "removed" : candidate.action}\t${candidate.reason}\t${candidate.runId}\n`,
    );
  process.stdout.write(
    `${apply ? "apply" : "preview"}: ${candidates.filter((x) => x.action === "remove").length} eligible run(s)\n`,
  );
}
