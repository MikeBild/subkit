import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CockpitDemoInstance } from "./cockpit-demo-instance.ts";

type LifecycleOperation = "start" | "stop" | "restart" | "reset" | "reseed";
type LifecycleCommand = { operation: LifecycleOperation; args: string[] };
export type DockerIdentity = { containers: string[]; volumes: string[] };
export type InstanceEvidence = {
  builtImageDigest: string | null;
  runningServices: Array<{
    id: string;
    name: string;
    imageDigest: string;
    state: string;
    service: string;
  }>;
  volumes: string[];
  databaseVolumeIdentity: string | null;
  objectStoreVolumeIdentity: string | null;
  serviceGenerationSha256: string;
  fixtureManifestSha256: string | null;
  fixtureDataSha256: string | null;
  seedDefinitionSha256: string | null;
  fixtureIdsSha256: string | null;
  fixtureIds: string[];
  keyStableAcrossReseed: boolean | null;
  countsStableAcrossReseed: boolean | null;
  fixtureIdsStableAcrossReseed?: boolean | null;
  seedDefinitionStableAcrossReseed?: boolean | null;
};
type LifecycleRunResult = { status: number; spawnFailed?: boolean };
type LifecycleRunner = (args: string[], env: Record<string, string>) => LifecycleRunResult;
type LifecycleExit = { operation: LifecycleOperation; status: number; spawn_failed?: true };

export const lifecycleCommands: LifecycleCommand[] = [
  { operation: "start", args: [] },
  { operation: "stop", args: ["--stop"] },
  { operation: "restart", args: ["--restart"] },
  { operation: "reset", args: ["--reset"] },
  { operation: "reseed", args: [] },
];

export function assertLifecycleInstanceIsolated(
  instance: CockpitDemoInstance,
  stateExists: boolean,
  occupiedPorts: ReadonlySet<number>,
  projectIdentity: DockerIdentity,
): void {
  if (!instance.id || !instance.project.startsWith("subkit-cockpit-demo-lifecycle-"))
    throw new Error("Lifecycle harness requires its generated isolated instance namespace");
  if (stateExists) throw new Error("Lifecycle instance state path already exists");
  if (occupiedPorts.has(instance.apiPort) || occupiedPorts.has(instance.dbPort))
    throw new Error("Lifecycle instance port collision; refusing to continue");
  if (projectIdentity.containers.length > 0 || projectIdentity.volumes.length > 0)
    throw new Error("Lifecycle Docker project already owns resources; refusing to continue");
}

export function dockerIdentityUnchanged(before: DockerIdentity, after: DockerIdentity): boolean {
  return (
    JSON.stringify([...before.containers].sort()) ===
      JSON.stringify([...after.containers].sort()) &&
    JSON.stringify([...before.volumes].sort()) === JSON.stringify([...after.volumes].sort())
  );
}

export function cockpitDemoSeedDefinitionFingerprint(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function validateLifecycleInstanceEvidence(
  identity: DockerIdentity,
  evidence: InstanceEvidence,
): string | null {
  const requiredServices = ["engine", "postgres", "object-store"];
  const services = new Map(evidence.runningServices.map((entry) => [entry.service, entry]));
  for (const service of requiredServices) {
    const entry = services.get(service);
    if (!entry) return "required_service_missing";
    if (!entry.state.startsWith("Up")) return "required_service_not_running";
    if (
      !identity.containers.some((container) => container.startsWith(`${entry.id}|${entry.name}|`))
    )
      return "container_identity_mismatch";
  }
  if (!evidence.databaseVolumeIdentity || !evidence.objectStoreVolumeIdentity)
    return "required_volume_missing";
  if (
    !identity.volumes.includes(evidence.databaseVolumeIdentity) ||
    !identity.volumes.includes(evidence.objectStoreVolumeIdentity)
  )
    return "volume_identity_mismatch";
  if (!evidence.builtImageDigest) return "built_image_missing";
  const engine = services.get("engine");
  if (!engine?.imageDigest || engine.imageDigest !== evidence.builtImageDigest)
    return "engine_image_mismatch";
  if (!identity.containers.length || !identity.volumes.length) return "project_identity_empty";
  return null;
}

export function lifecycleInputHashes(
  root: string,
  instance?: CockpitDemoInstance,
): Record<string, string> {
  const entries = [
    ["source", ["scripts/start-cockpit-demo.ts", "scripts/lib/cockpit-demo-lifecycle-harness.ts"]],
    ["compose", ["docker-compose.test.yml", "docker-compose.demo.yml"]],
    ["config", ["subkit.config.example.json", "package.json"]],
    ["fixtures", ["scripts/lib/cockpit-demo-seed.ts"]],
  ] as const;
  return Object.fromEntries(
    entries.map(([name, files]) => {
      const hash = createHash("sha256");
      for (const file of files) hash.update(file).update(readFileSync(join(root, file)));
      if (name === "config" && instance)
        hash.update(
          JSON.stringify({
            project: instance.project,
            apiPort: instance.apiPort,
            dbPort: instance.dbPort,
            baseUrl: instance.baseUrl,
            stateDir: instance.stateDir,
          }),
        );
      return [`${name}_sha256`, hash.digest("hex")];
    }),
  );
}

export function lifecycleReceipt(input: {
  instance: CockpitDemoInstance;
  hashes: Record<string, string>;
  before: DockerIdentity | null;
  after: DockerIdentity | null;
  exits: LifecycleExit[];
  runnerSha256: string;
  sourceHead: string;
  fixtureManifestSha256: string;
  fixtureDataSha256: string;
  instanceBeforeCleanup: InstanceEvidence | null;
  projectIdentityBeforeCleanup: DockerIdentity | null;
  cleanupStatus: number;
  cleanupAttempted: boolean;
  cleanupReason: string;
  isolatedAfterCleanup: DockerIdentity | null;
  cleanupRecovery: string;
  failureCode: string | null;
}) {
  return {
    schema: "subkit-local-demo-lifecycle-v1",
    instance: {
      id: input.instance.id,
      project: input.instance.project,
      apiPort: input.instance.apiPort,
      dbPort: input.instance.dbPort,
      statePath: resolve(input.instance.stateDir),
    },
    source_head: input.sourceHead,
    runner_sha256: input.runnerSha256,
    input_hashes: input.hashes,
    commands: input.exits,
    fixture_manifest_sha256: input.fixtureManifestSha256,
    fixture_data_sha256: input.fixtureDataSha256,
    instance_before_cleanup: input.instanceBeforeCleanup,
    project_identity_before_cleanup: input.projectIdentityBeforeCleanup,
    cleanup: {
      status: input.cleanupStatus,
      attempted: input.cleanupAttempted,
      reason: input.cleanupReason,
      isolatedProjectEmpty:
        input.isolatedAfterCleanup !== null
          ? input.isolatedAfterCleanup.containers.length === 0 &&
            input.isolatedAfterCleanup.volumes.length === 0
          : null,
      isolatedProjectAfter: input.isolatedAfterCleanup,
      recovery: input.cleanupRecovery,
    },
    failure_code: input.failureCode,
    default_demo_identity: {
      unchanged:
        input.before !== null && input.after !== null
          ? dockerIdentityUnchanged(input.before, input.after)
          : null,
      before: input.before,
      after: input.after,
    },
  };
}

export function runLifecycleSequence(
  commands: LifecycleCommand[],
  run: LifecycleRunner,
  env: Record<string, string>,
  afterStep?: (operation: LifecycleOperation, status: number) => void,
): LifecycleExit[] {
  const exits: LifecycleExit[] = [];
  for (const command of commands) {
    let result: LifecycleRunResult;
    try {
      result = run(command.args, env);
    } catch {
      result = { status: 127, spawnFailed: true };
    }
    const status = result.status;
    exits.push({
      operation: command.operation,
      status,
      ...(result.spawnFailed ? { spawn_failed: true } : {}),
    });
    afterStep?.(command.operation, status);
    if (status !== 0) break;
  }
  return exits;
}
