import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startOwnedChild } from "../../../../scripts/lib/owned-process-watchdog.ts";
import { createIsolatedTestHome, removeIsolatedTestHome } from "./isolated-test-home";

export type IsolatedTestFileOptions = {
  cwd: string;
  deadlineMs?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  onTerminal?: (outcome: {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    error: string | null;
  }) => void;
  onOutput?: (chunk: Buffer) => void;
};

const DOCKER_CLI_PLUGIN_DIRS = [
  "/Applications/Docker.app/Contents/Resources/cli-plugins",
  "/usr/local/lib/docker/cli-plugins",
  "/usr/local/libexec/docker/cli-plugins",
  "/usr/lib/docker/cli-plugins",
  "/usr/libexec/docker/cli-plugins",
];

function configureDockerCliPlugins(home: string): void {
  const pluginDirs = DOCKER_CLI_PLUGIN_DIRS.filter(existsSync);
  if (pluginDirs.length === 0) return;
  const dockerConfig = join(home, ".docker");
  mkdirSync(dockerConfig, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dockerConfig, "config.json"),
    `${JSON.stringify({ cliPluginsExtraDirs: pluginDirs })}\n`,
    { mode: 0o600 },
  );
}

function isDockerTest(file: string): boolean {
  return /\.docker\.test\.[cm]?[jt]sx?$/.test(file);
}

function dockerHost(env: NodeJS.ProcessEnv | undefined): string | undefined {
  if (env?.DOCKER_HOST !== undefined) return env.DOCKER_HOST;
  if (process.env.DOCKER_HOST !== undefined) return process.env.DOCKER_HOST;
  const context = spawnSync(
    "docker",
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    { encoding: "utf8" },
  );
  const endpoint = context.status === 0 ? context.stdout.trim() : "";
  return endpoint || undefined;
}

export async function runIsolatedTestFile(
  file: string,
  { cwd, deadlineMs, killGraceMs = 5_000, env, onTerminal, onOutput }: IsolatedTestFileOptions,
): Promise<void> {
  const home = createIsolatedTestHome();
  try {
    const dockerTest = isDockerTest(file);
    const effectiveDeadlineMs = deadlineMs ?? (dockerTest ? 20 * 60_000 : 150_000);
    const ownsDockerConfig =
      dockerTest && env?.DOCKER_CONFIG === undefined && process.env.DOCKER_CONFIG === undefined;
    const isolatedDockerHost = dockerTest ? dockerHost(env) : undefined;
    if (dockerTest) configureDockerCliPlugins(home.path);
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...env,
      HOME: home.path,
      USERPROFILE: home.path,
      ...(ownsDockerConfig ? { DOCKER_CONFIG: join(home.path, ".docker") } : {}),
      ...(isolatedDockerHost !== undefined ? { DOCKER_HOST: isolatedDockerHost } : {}),
      SUBKIT_TEST_HOME: home.path,
      SUBKIT_TEST_HOME_TOKEN: home.token,
      NODE_ENV: "test",
    };
    childEnv.LLM_PROVIDER ??= "mock";
    const child = startOwnedChild(
      "bun",
      ["test", "--timeout", dockerTest ? "600000" : "120000", file],
      { cwd, env: childEnv, stdio: onOutput ? ["ignore", "pipe", "pipe"] : "inherit" },
      effectiveDeadlineMs,
      killGraceMs,
    );
    let outputError: unknown;
    if (onOutput) {
      const failOutput = (error: unknown) => {
        outputError ??= error;
        child.stop();
      };
      const capture = (chunk: Buffer) => {
        try {
          onOutput(chunk);
        } catch (error) {
          failOutput(error);
        }
      };
      child.child.stdout?.on("data", capture);
      child.child.stderr?.on("data", capture);
      child.child.stdout?.on("error", failOutput);
      child.child.stderr?.on("error", failOutput);
    }
    const outcome = await child.completed;
    onTerminal?.({
      exitCode: outcome.exitCode ?? null,
      signal: outcome.signal ?? null,
      timedOut: outcome.timedOut,
      error: outcome.error ? String(outcome.error) : null,
    });
    if (outputError !== undefined) throw outputError;
    if (outcome.timedOut) {
      throw new Error(`${file} exceeded the ${effectiveDeadlineMs}ms process deadline`);
    }
    if (outcome.exitCode !== 0 || outcome.error) {
      throw new Error(
        `${file} failed with exit code ${outcome.exitCode ?? "unknown"}${outcome.error ? `: ${outcome.error}` : ""}`,
      );
    }
  } finally {
    removeIsolatedTestHome(home);
  }
}
