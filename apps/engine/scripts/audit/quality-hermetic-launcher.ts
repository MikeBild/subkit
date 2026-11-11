import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const QUALITY_ENV = new Set([
  "DATABASE_URL",
  "SUBKIT_COVERAGE_OWNED_DATABASE_URL",
  "MASTER_KEY",
  "SUBKIT_QUALITY_HERMETIC_CI",
  "SUBKIT_QUALITY_COMMIT",
  "SUBKIT_QUALITY_SHARD",
]);
const RUNTIME_ENV = ["GITHUB_OUTPUT", "GITHUB_RUN_ID", "GITHUB_SHA"] as const;

export function hermeticQualityEnvironment(
  ambient: Readonly<NodeJS.ProcessEnv>,
  home: string,
  executable: string,
): NodeJS.ProcessEnv {
  const unknown = Object.keys(ambient)
    .filter((key) => key.startsWith("SUBKIT_") && !QUALITY_ENV.has(key))
    .sort();
  if (unknown.length > 0)
    throw new Error(`Quality launcher rejects undeclared SUBKIT inputs: ${unknown.join(", ")}`);
  if (ambient.SUBKIT_QUALITY_HERMETIC_CI !== "1")
    throw new Error("Quality launcher requires SUBKIT_QUALITY_HERMETIC_CI=1");
  const environment: NodeJS.ProcessEnv = {
    PATH: `${dirname(executable)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    NODE_ENV: "test",
    LLM_PROVIDER: "mock",
    SKIP_DOCKER: "1",
    CI: "true",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    SUBKIT_QUALITY_HERMETIC_LAUNCHER: "1",
  };
  for (const key of RUNTIME_ENV) if (ambient[key] !== undefined) environment[key] = ambient[key];
  for (const key of QUALITY_ENV) if (ambient[key] !== undefined) environment[key] = ambient[key];
  delete environment.SUBKIT_QUALITY_HERMETIC_CI;
  if (environment.SUBKIT_COVERAGE_OWNED_DATABASE_URL !== undefined)
    environment.DATABASE_URL = environment.SUBKIT_COVERAGE_OWNED_DATABASE_URL;
  return environment;
}

export function runHermeticQualityAction(options: {
  executable: string;
  script: string;
  action: string;
  ambient: Readonly<NodeJS.ProcessEnv>;
}): never {
  const home = mkdtempSync(join(tmpdir(), "subkit-quality-home-"));
  try {
    execFileSync(options.executable, [options.script, options.action], {
      stdio: "inherit",
      env: hermeticQualityEnvironment(options.ambient, home, options.executable),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  process.exit(0);
}
