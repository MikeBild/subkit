import { RELEASE_HISTORY } from "../apps/cockpit/src/app/release-notes.generated.ts";

const result = Bun.spawnSync(
  ["bun", "run", "gen:release-notes", "--", "--release", RELEASE_HISTORY.source, "--check"],
  { cwd: `${import.meta.dir}/..`, stdout: "inherit", stderr: "inherit" },
);

process.exit(result.exitCode);
