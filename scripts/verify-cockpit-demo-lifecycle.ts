#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cockpitDemoCheckoutFingerprint } from "./lib/cockpit-demo-fingerprint.ts";
import {
  assertCockpitDemoMarker,
  readCockpitDemoMarker,
  resolveCockpitDemoInstance,
} from "./lib/cockpit-demo-instance.ts";
import {
  assertLifecycleInstanceIsolated,
  cockpitDemoSeedDefinitionFingerprint,
  type DockerIdentity,
  dockerIdentityUnchanged,
  type InstanceEvidence,
  lifecycleCommands,
  lifecycleInputHashes,
  lifecycleReceipt,
  runLifecycleSequence,
  validateLifecycleInstanceEvidence,
} from "./lib/cockpit-demo-lifecycle-harness.ts";
import {
  cockpitDemoManifest,
  cockpitDemoOwnerSql,
  createCockpitDemoSeedSql,
  demoFiles,
} from "./lib/cockpit-demo-seed.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROJECT = "subkit-cockpit-demo";
const RECEIPT_ROOT = join(ROOT, ".artifacts", "cockpit-demo", "lifecycle-receipts");
type SeedEvidence = {
  keyHash: string;
  counts: unknown;
  seedDefinitionSha256: string;
  fixtureIds: string[];
  fixtureIdsSha256: string | null;
};
type ReseedComparison = {
  key: boolean;
  counts: boolean;
  fixtureIds: boolean;
  seedDefinition: boolean;
};

function docker(args: string[]): string {
  const result = spawnSync("docker", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) throw new Error("docker_metadata_unavailable");
  return result.stdout.trim();
}

function dockerIdentity(project: string): DockerIdentity {
  const containers = docker([
    "ps",
    "--all",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--format",
    "{{.ID}}|{{.Names}}|{{.Image}}",
  ])
    .split("\n")
    .filter(Boolean)
    .sort();
  const volumes = docker([
    "volume",
    "ls",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--format",
    "{{.Name}}",
  ])
    .split("\n")
    .filter(Boolean)
    .sort();
  return { containers, volumes };
}

function imageDigest(reference: string): string | null {
  const result = spawnSync("docker", ["image", "inspect", reference, "--format", "{{.Id}}"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function instanceSnapshot(project: string, image: string): InstanceEvidence {
  const entries = docker([
    "ps",
    "--all",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--format",
    '{{.ID}}|{{.Names}}|{{.Status}}|{{.Label "com.docker.compose.service"}}',
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, name, state, service] = line.split("|");
      const digest = docker(["inspect", "--format", "{{.Image}}", id]);
      return { id, name, state, service, imageDigest: digest };
    })
    .sort((left, right) => left.service.localeCompare(right.service));
  const volumes = dockerIdentity(project).volumes;
  const generation = createHash("sha256")
    .update(JSON.stringify({ entries, volumes }))
    .digest("hex");
  const stateDir = join(
    ROOT,
    ".artifacts",
    "cockpit-demo",
    project.replace("subkit-cockpit-demo-", ""),
  );
  const state = readJson<{ tenantId?: string; uploadedFiles?: Record<string, string> }>(
    join(stateDir, "state.json"),
  );
  const fixtureIdsSha256 = state?.uploadedFiles
    ? createHash("sha256").update(JSON.stringify(state.uploadedFiles)).digest("hex")
    : null;
  return {
    builtImageDigest: imageDigest(image),
    runningServices: entries,
    volumes,
    databaseVolumeIdentity: volumes.find((volume) => volume.endsWith("_demo-postgres")) ?? null,
    objectStoreVolumeIdentity: volumes.find((volume) => volume.endsWith("_demo-objects")) ?? null,
    serviceGenerationSha256: generation,
    fixtureManifestSha256: createHash("sha256")
      .update(JSON.stringify(cockpitDemoManifest))
      .digest("hex"),
    fixtureDataSha256: createHash("sha256").update(JSON.stringify(demoFiles)).digest("hex"),
    seedDefinitionSha256: null,
    fixtureIdsSha256,
    fixtureIds: Object.values(state?.uploadedFiles ?? {}).sort(),
    keyStableAcrossReseed: null,
    countsStableAcrossReseed: null,
  };
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function freePort(excluded: ReadonlySet<number>): Promise<number> {
  while (true) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("port_probe_failed"));
          return;
        }
        server.close((error) => (error ? reject(error) : resolvePort(address.port)));
      });
    });
    if (!excluded.has(port) && port !== 3000 && port !== 55439) return port;
  }
}

function sourceHead(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) throw new Error("source_pin_unavailable");
  return result.stdout.trim();
}

function composeArgs(project: string): string[] {
  return [
    "compose",
    "--env-file",
    "/dev/null",
    "-p",
    project,
    "-f",
    "docker-compose.test.yml",
    "-f",
    "docker-compose.demo.yml",
  ];
}

function ensureReceiptDirectory(): void {
  mkdirSync(RECEIPT_ROOT, { recursive: true, mode: 0o700 });
  const receiptDirectory = lstatSync(RECEIPT_ROOT);
  if (
    !receiptDirectory.isDirectory() ||
    receiptDirectory.isSymbolicLink() ||
    realpathSync(RECEIPT_ROOT) !== resolve(RECEIPT_ROOT)
  )
    throw new Error("receipt_directory_invalid");
  chmodSync(RECEIPT_ROOT, 0o700);
}

async function main(): Promise<void> {
  const id = `lifecycle-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const apiPort = await freePort(new Set());
  const dbPort = await freePort(new Set([apiPort]));
  const environment = {
    ...process.env,
    SUBKIT_DEMO_INSTANCE: id,
    SUBKIT_TEST_PORT: String(apiPort),
    SUBKIT_DEMO_DB_PORT: String(dbPort),
  };
  const instance = resolveCockpitDemoInstance(environment, ROOT);
  const receiptPath = join(RECEIPT_ROOT, `${id}.json`);
  const recovery = `If cleanup.attempted is true, use the receipt's exact project/container/volume identities before retrying docker compose -p ${instance.project} -f docker-compose.test.yml -f docker-compose.demo.yml down --volumes --remove-orphans from ${ROOT}; remove the private state path only after its instance marker matches ${instance.project}. If cleanup.attempted is false, retain state and receipt; first inspect Docker identities for the exact generated project and compare them with the receipt and default demo identity. Only after confirming that every resource belongs exclusively to this disposable project may the same project-scoped down command be run. If identity is uncertain or isolation preflight failed, leave resources untouched for manual recovery. Never use global prune.`;
  const portCollisions = new Set<number>();
  let beforeIdentity: DockerIdentity | null = null;
  let afterIdentity: DockerIdentity | null = null;
  let preCleanup: InstanceEvidence | null = null;
  let projectBeforeCleanup: DockerIdentity | null = null;
  const seedProgress: { baseline: SeedEvidence | null; comparison: ReseedComparison | null } = {
    baseline: null,
    comparison: null,
  };
  let exits: ReturnType<typeof runLifecycleSequence> = [];
  let cleanupStatus = 1;
  let cleanupAttempted = false;
  let cleanupReason = "not_started";
  let isolatedAfterCleanup: DockerIdentity | null = null;
  let stateCleanupStatus = 1;
  let failureCode: string | null = null;
  let hashes: Record<string, string> = {};
  let runnerSha256 = "unavailable";
  let pinnedHead = "unavailable";
  let defaultAfterError = false;
  let namespaceAccepted = false;

  try {
    ensureReceiptDirectory();
    if (existsSync(receiptPath)) throw new Error("receipt_collision");
    if (existsSync(instance.stateDir)) throw new Error("state_path_collision");
    for (const port of [apiPort, dbPort]) {
      const server = createServer();
      try {
        await new Promise<void>((resolveListen, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () =>
            server.close((error) => (error ? reject(error) : resolveListen())),
          );
        });
      } catch {
        portCollisions.add(port);
      }
    }
    const emptyProjectIdentity = dockerIdentity(instance.project);
    assertLifecycleInstanceIsolated(instance, false, portCollisions, emptyProjectIdentity);
    namespaceAccepted = true;
    beforeIdentity = dockerIdentity(DEFAULT_PROJECT);
    hashes = {
      ...lifecycleInputHashes(ROOT, instance),
      checkout_source_sha256: cockpitDemoCheckoutFingerprint(ROOT),
      fixture_manifest_sha256: createHash("sha256")
        .update(JSON.stringify(cockpitDemoManifest))
        .digest("hex"),
      fixture_data_sha256: createHash("sha256").update(JSON.stringify(demoFiles)).digest("hex"),
    };
    pinnedHead = sourceHead();
    runnerSha256 = createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .update(readFileSync(join(ROOT, "scripts/lib/cockpit-demo-lifecycle-harness.ts")))
      .digest("hex");
    const lifecycleEnv = {
      ...environment,
      SUBKIT_DEMO_STATE_DIR: resolve(instance.stateDir),
      SUBKIT_DEMO_URL: instance.baseUrl,
    };
    exits = runLifecycleSequence(
      lifecycleCommands,
      (args, commandEnv) => {
        const child = spawnSync(
          "bun",
          ["run", "scripts/start-cockpit-demo.ts", ...args, "--mock"],
          {
            cwd: ROOT,
            env: commandEnv,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        if (child.error) return { status: 127, spawnFailed: true };
        return { status: child.status ?? 1 };
      },
      lifecycleEnv,
      (operation, status) => {
        if (status !== 0) return;
        if (operation === "reset") seedProgress.baseline = seedEvidence(instance);
        if (operation === "reseed") {
          const current = seedEvidence(instance);
          const baseline = seedProgress.baseline;
          if (baseline) {
            seedProgress.comparison = {
              key: baseline.keyHash === current.keyHash,
              counts: JSON.stringify(baseline.counts) === JSON.stringify(current.counts),
              fixtureIds:
                baseline.fixtureIdsSha256 !== null &&
                baseline.fixtureIdsSha256 === current.fixtureIdsSha256,
              seedDefinition: baseline.seedDefinitionSha256 === current.seedDefinitionSha256,
            };
          }
        }
      },
    );
    if (exits.length !== lifecycleCommands.length || exits.some((entry) => entry.status !== 0))
      failureCode = "lifecycle_command_failed";
    if (seedProgress.comparison && Object.values(seedProgress.comparison).some((stable) => !stable))
      failureCode = "reseed_not_idempotent";
    projectBeforeCleanup = dockerIdentity(instance.project);
    preCleanup = instanceSnapshot(instance.project, `subkit:cockpit-demo-${id}`);
    const evidenceError = validateLifecycleInstanceEvidence(projectBeforeCleanup, preCleanup);
    if (evidenceError) failureCode ??= evidenceError;
    if (
      !seedProgress.comparison ||
      Object.values(seedProgress.comparison).some((stable) => !stable)
    )
      failureCode ??= "reseed_evidence_incomplete";
  } catch {
    failureCode ??= "preflight_or_lifecycle_failure";
  } finally {
    if (namespaceAccepted) {
      if (!projectBeforeCleanup || !preCleanup) {
        cleanupStatus = 125;
        cleanupReason = "pre_cleanup_identity_unavailable";
      } else if (validateLifecycleInstanceEvidence(projectBeforeCleanup, preCleanup) !== null) {
        cleanupStatus = 125;
        cleanupReason = "pre_cleanup_identity_invalid";
      } else {
        try {
          const currentProjectIdentity = dockerIdentity(instance.project);
          if (!dockerIdentityUnchanged(projectBeforeCleanup, currentProjectIdentity)) {
            cleanupStatus = 125;
            cleanupReason = "pre_cleanup_identity_changed";
          } else {
            cleanupAttempted = true;
            cleanupReason = "project_identity_confirmed";
            const down = spawnSync(
              "docker",
              [...composeArgs(instance.project), "down", "--volumes", "--remove-orphans"],
              { cwd: ROOT, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
            );
            cleanupStatus = down.error ? 127 : (down.status ?? 1);
            if (down.error) cleanupReason = "cleanup_spawn_failed";
            else if (cleanupStatus !== 0) cleanupReason = "cleanup_command_failed";
            else cleanupReason = "cleanup_succeeded";
            if (cleanupStatus === 0) {
              try {
                if (existsSync(instance.stateDir)) {
                  const marker = readCockpitDemoMarker(instance);
                  assertCockpitDemoMarker(marker, instance);
                  rmSync(instance.stateDir, { recursive: true, force: false });
                }
                stateCleanupStatus = 0;
              } catch {
                stateCleanupStatus = 1;
              }
            }
          }
        } catch {
          if (cleanupStatus === 1) cleanupStatus = 127;
          if (cleanupReason === "project_identity_confirmed") cleanupReason = "cleanup_exception";
        }
      }
      try {
        isolatedAfterCleanup = dockerIdentity(instance.project);
        if (isolatedAfterCleanup.containers.length > 0 || isolatedAfterCleanup.volumes.length > 0)
          cleanupStatus = cleanupStatus || 1;
      } catch {
        cleanupStatus = cleanupStatus || 127;
      }
    }
    try {
      afterIdentity = dockerIdentity(DEFAULT_PROJECT);
    } catch {
      defaultAfterError = true;
    }
    try {
      ensureReceiptDirectory();
      const fixtureManifestSha256 = hashes.fixture_manifest_sha256 ?? "unavailable";
      const fixtureDataSha256 = hashes.fixture_data_sha256 ?? "unavailable";
      const reseedEvidence: InstanceEvidence | null = preCleanup
        ? {
            ...preCleanup,
            fixtureManifestSha256,
            fixtureDataSha256,
            seedDefinitionSha256: seedProgress.baseline?.seedDefinitionSha256 ?? null,
            keyStableAcrossReseed: seedProgress.comparison?.key ?? false,
            countsStableAcrossReseed: seedProgress.comparison?.counts ?? false,
            fixtureIdsStableAcrossReseed: seedProgress.comparison?.fixtureIds ?? false,
            seedDefinitionStableAcrossReseed: seedProgress.comparison?.seedDefinition ?? false,
            fixtureIdsSha256: seedProgress.comparison?.fixtureIds
              ? (seedProgress.baseline?.fixtureIdsSha256 ?? null)
              : null,
            fixtureIds: seedProgress.comparison?.fixtureIds
              ? (seedProgress.baseline?.fixtureIds ?? [])
              : [],
          }
        : null;
      if (!failureCode && (cleanupStatus !== 0 || stateCleanupStatus !== 0))
        failureCode = "cleanup_incomplete";
      if (!failureCode && defaultAfterError) failureCode = "default_identity_after_unavailable";
      if (
        !failureCode &&
        beforeIdentity !== null &&
        afterIdentity !== null &&
        JSON.stringify(beforeIdentity) !== JSON.stringify(afterIdentity)
      )
        failureCode = "default_identity_changed";
      const receipt = lifecycleReceipt({
        instance,
        hashes,
        before: beforeIdentity,
        after: afterIdentity,
        exits,
        runnerSha256,
        sourceHead: pinnedHead,
        fixtureManifestSha256,
        fixtureDataSha256,
        instanceBeforeCleanup: reseedEvidence,
        projectIdentityBeforeCleanup: projectBeforeCleanup,
        cleanupStatus,
        cleanupAttempted,
        cleanupReason,
        isolatedAfterCleanup,
        cleanupRecovery: recovery,
        failureCode:
          failureCode ?? (defaultAfterError ? "default_identity_after_unavailable" : null),
      });
      writeFileSync(
        receiptPath,
        `${JSON.stringify({ ...receipt, state_cleanup_status: stateCleanupStatus }, null, 2)}\n`,
        {
          mode: 0o600,
          flag: "wx",
        },
      );
    } catch {
      failureCode ??= "receipt_write_failed";
    }
  }

  const receipt = readJson<{
    default_demo_identity?: { unchanged?: boolean };
    cleanup?: { status?: number; isolatedProjectEmpty?: boolean };
  }>(receiptPath);
  if (
    failureCode ||
    defaultAfterError ||
    receipt?.default_demo_identity?.unchanged !== true ||
    cleanupStatus !== 0 ||
    stateCleanupStatus !== 0 ||
    receipt.cleanup?.isolatedProjectEmpty !== true
  ) {
    process.stderr.write(
      `Lifecycle verification failed (${failureCode ?? "preservation_or_cleanup_failed"}); receipt: ${receiptPath}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Lifecycle receipt: ${receiptPath}\n`);
}

function seedEvidence(instance: ReturnType<typeof resolveCockpitDemoInstance>): SeedEvidence {
  const stateDir = instance.stateDir;
  const state = readJson<{ tenantId?: string; uploadedFiles?: Record<string, string> }>(
    join(stateDir, "state.json"),
  );
  const receipt = readJson<{ counts?: unknown }>(join(stateDir, "receipt.json"));
  const keyHash = createHash("sha256")
    .update(readFileSync(join(stateDir, "api-key.txt")))
    .digest("hex");
  const identity = docker([
    ...composeArgs(instance.project),
    "exec",
    "-T",
    "postgres",
    "psql",
    "-X",
    "-U",
    "subkit",
    "-d",
    "subkit",
    "-A",
    "-t",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `SELECT t.id || '|' || u.id FROM tenants t JOIN users u ON u.tenant_id=t.id ${cockpitDemoOwnerSql} LIMIT 1;`,
  ])
    .split("\n")
    .filter(Boolean);
  if (identity.length !== 1) throw new Error("seed_identity_unavailable");
  const [tenantId, adminUserId] = identity[0].split("|");
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[0-9a-f-]{36}$/i.test(adminUserId))
    throw new Error("seed_identity_invalid");
  const seedSql = createCockpitDemoSeedSql(tenantId, adminUserId);
  const seedDefinitionSha256 = cockpitDemoSeedDefinitionFingerprint(
    readFileSync(join(ROOT, "scripts/lib/cockpit-demo-seed.ts"), "utf8"),
  );
  const databaseFixtureIds = [
    ...new Set(
      seedSql.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [],
    ),
  ].filter(
    (id) =>
      id.toLowerCase() !== tenantId.toLowerCase() && id.toLowerCase() !== adminUserId.toLowerCase(),
  );
  const fixtureIds = [
    ...new Set([...databaseFixtureIds, ...Object.values(state?.uploadedFiles ?? [])]),
  ].sort();
  return {
    keyHash,
    counts: receipt?.counts ?? null,
    seedDefinitionSha256,
    fixtureIds,
    fixtureIdsSha256:
      state?.uploadedFiles && state.tenantId === tenantId
        ? createHash("sha256").update(JSON.stringify(fixtureIds)).digest("hex")
        : null,
  };
}

await main();
