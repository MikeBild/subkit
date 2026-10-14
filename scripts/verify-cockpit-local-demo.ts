import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cockpitDemoCheckoutFingerprint } from "./lib/cockpit-demo-fingerprint.ts";
import {
  cockpitDemoBaseUrl,
  cockpitDemoStateDirectory,
  resolveCockpitDemoInstance,
} from "./lib/cockpit-demo-instance.ts";
import { localChatVerificationMode } from "./lib/cockpit-demo-verification.ts";

const args = process.argv.slice(2);

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun run demo:local:verify [--mock]");
  console.log("Runs local API and browser journeys; --mock verifies chat without a provider key.");
  process.exit(0);
}
if (args.some((arg) => arg !== "--mock") || new Set(args).size !== args.length)
  throw new Error(`Unknown or duplicate option: ${args[0]}`);

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const instance = resolveCockpitDemoInstance(process.env, ROOT);
const directory = cockpitDemoStateDirectory(instance, process.env.SUBKIT_DEMO_STATE_DIR);
const targetBaseUrl = cockpitDemoBaseUrl(
  instance,
  process.env.SUBKIT_DEMO_URL ??
    (instance.id ? instance.baseUrl : (process.env.SUBKIT_LOCAL_URL ?? instance.baseUrl)),
);
const build = await readJson<{ source?: unknown; image?: unknown }>(
  resolve(directory, "build.json"),
);
if (
  !build ||
  build.source !== cockpitDemoCheckoutFingerprint(ROOT) ||
  typeof build.image !== "string" ||
  !/^sha256:[a-f0-9]{64}$/.test(build.image)
)
  throw new Error(
    "Local demo build is stale or missing; start/rebuild the demo before verification",
  );
const compose = [
  "compose",
  "--env-file",
  "/dev/null",
  "-p",
  instance.project,
  "-f",
  resolve(ROOT, "docker-compose.test.yml"),
  "-f",
  resolve(ROOT, "docker-compose.demo.yml"),
];
const dockerEnv = {
  ...process.env,
  SUBKIT_TEST_PORT: String(instance.apiPort),
  SUBKIT_DB_PORT: String(instance.dbPort),
  SUBKIT_TEST_IMAGE: instance.id ? `subkit:cockpit-demo-${instance.id}` : "subkit:cockpit-demo",
  SUBKIT_DEMO_STATE_DIR: directory,
  ...(instance.id ? { SUBKIT_DEMO_INSTANCE: instance.id } : {}),
};
const engineContainer = spawnSync("docker", [...compose, "ps", "-q", "engine"], {
  cwd: ROOT,
  env: dockerEnv,
  encoding: "utf8",
});
if (engineContainer.status !== 0 || !engineContainer.stdout.trim())
  throw new Error("Local demo engine container is not running for the selected instance");
const runtimeImage = spawnSync(
  "docker",
  ["inspect", "--format", "{{.Image}}", engineContainer.stdout.trim()],
  { cwd: ROOT, env: dockerEnv, encoding: "utf8" },
);
if (runtimeImage.status !== 0 || runtimeImage.stdout.trim() !== build.image)
  throw new Error("Running local demo image does not match its current build receipt");
const mockChat = localChatVerificationMode(args.includes("--mock")) === "mock";

for (const command of [
  ["scripts/verify-cockpit-local.ts", "--keep-workflow"],
  ["scripts/verify-local-cockpit-browser.mjs", ...(mockChat ? ["--mock-chat"] : [])],
]) {
  const result = Bun.spawnSync(["bun", ...command], {
    cwd: ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      SUBKIT_DEMO_STATE_DIR: directory,
      SUBKIT_DEMO_URL: targetBaseUrl.origin,
    },
  });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}
