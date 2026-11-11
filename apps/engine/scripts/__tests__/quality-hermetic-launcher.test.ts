import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverageExecutionContext } from "../audit/coverage-environment.ts";
import { hermeticQualityEnvironment } from "../audit/quality-hermetic-launcher.ts";

test("quality launcher makes coordinator and shard test contexts identical despite ambient metadata", () => {
  const common = {
    PATH: "/tools/bin",
    DATABASE_URL: "postgres://ambient",
    SUBKIT_COVERAGE_OWNED_DATABASE_URL: "postgres://owned",
    MASTER_KEY: "a".repeat(64),
    FEATURE_FLAG: "enabled",
    SUBKIT_QUALITY_HERMETIC_CI: "1",
  };
  const coordinator = hermeticQualityEnvironment(
    {
      ...common,
      GITHUB_JOB: "coordinator",
      GITHUB_OUTPUT: "/tmp/coordinator",
      npm_lifecycle_event: "prepare",
    },
    "/tmp/coordinator-home",
    process.execPath,
  );
  const shard = hermeticQualityEnvironment(
    {
      ...common,
      GITHUB_JOB: "rbac",
      GITHUB_OUTPUT: "/tmp/rbac",
      npm_lifecycle_event: "coverage",
      SUBKIT_QUALITY_SHARD: "rbac",
    },
    "/tmp/rbac-home",
    process.execPath,
  );
  expect(coverageExecutionContext(coordinator, ["db"])).toEqual(
    coverageExecutionContext(shard, ["db"]),
  );
  expect(coordinator.DATABASE_URL).toBe("postgres://owned");
  expect(shard.HOME).toBe("/tmp/rbac-home");
});

test("quality launcher rejects undeclared SubKit feature inputs and binds declared semantic inputs", () => {
  expect(() =>
    hermeticQualityEnvironment(
      { PATH: "/tools", SUBKIT_EXPERIMENT: "on", SUBKIT_QUALITY_HERMETIC_CI: "1" },
      "/tmp/home",
      process.execPath,
    ),
  ).toThrow("rejects undeclared SUBKIT inputs");
  expect(() =>
    hermeticQualityEnvironment(
      {
        PATH: "/tools",
        SUBKIT_QUALITY_HERMETIC_CI: "1",
        SUBKIT_QUALITY_HERMETIC_LAUNCHER: "1",
      },
      "/tmp/home",
      process.execPath,
    ),
  ).toThrow("rejects undeclared SUBKIT inputs");
  const base = hermeticQualityEnvironment(
    { PATH: "/tools", MASTER_KEY: "a".repeat(64), SUBKIT_QUALITY_HERMETIC_CI: "1" },
    "/tmp/home",
    process.execPath,
  );
  const changed = hermeticQualityEnvironment(
    { PATH: "/tools", MASTER_KEY: "b".repeat(64), SUBKIT_QUALITY_HERMETIC_CI: "1" },
    "/tmp/home",
    process.execPath,
  );
  expect(coverageExecutionContext(changed, [])).not.toEqual(coverageExecutionContext(base, []));
});

test("quality launcher reexecutes actual children with a portable strict context", () => {
  const root = mkdtempSync(join(tmpdir(), "subkit-quality-launcher-"));
  const child = join(root, "context.ts");
  const parent = join(root, "launcher.ts");
  writeFileSync(
    child,
    `import { coverageExecutionContext } from ${JSON.stringify(join(import.meta.dir, "..", "audit", "coverage-environment.ts"))}; console.log(JSON.stringify(coverageExecutionContext(process.env, ["db"])));`,
  );
  writeFileSync(
    parent,
    `import { runHermeticQualityAction } from ${JSON.stringify(join(import.meta.dir, "..", "audit", "quality-hermetic-launcher.ts"))}; runHermeticQualityAction({ executable: process.execPath, script: process.argv[2]!, action: "child", ambient: process.env });`,
  );
  try {
    const run = (ambient: NodeJS.ProcessEnv) => {
      const result = spawnSync(process.execPath, [parent, child], {
        encoding: "utf8",
        env: { ...ambient, TMPDIR: root },
      });
      expect(result.status).toBe(0);
      return result.stdout.trim();
    };
    const coordinator = run({
      PATH: process.env.PATH!,
      GITHUB_JOB: "coordinator",
      npm_lifecycle_event: "prepare",
      SUBKIT_QUALITY_HERMETIC_CI: "1",
      MASTER_KEY: "a".repeat(64),
    });
    const shard = run({
      PATH: process.env.PATH!,
      GITHUB_JOB: "rbac",
      npm_lifecycle_event: "coverage",
      SUBKIT_QUALITY_HERMETIC_CI: "1",
      MASTER_KEY: "a".repeat(64),
    });
    expect(shard).toBe(coordinator);
    expect(
      run({
        PATH: process.env.PATH!,
        SUBKIT_QUALITY_HERMETIC_CI: "1",
        MASTER_KEY: "b".repeat(64),
      }),
    ).not.toBe(coordinator);
    expect(readdirSync(root).filter((name) => name.startsWith("subkit-quality-home-")).length).toBe(
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
