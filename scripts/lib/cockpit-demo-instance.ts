import { chmodSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type CockpitDemoInstance = {
  id: string | null;
  project: string;
  apiPort: number;
  dbPort: number;
  baseUrl: string;
  stateDir: string;
};

type CockpitDemoMarker = {
  schema: "subkit-cockpit-demo-instance-v1";
  instanceId: string | null;
  project: string;
  apiPort: number;
  dbPort: number;
  image: string;
  source: string;
};

export function cockpitDemoImage(instance: CockpitDemoInstance): string {
  return instance.id ? `subkit:cockpit-demo-${instance.id}` : "subkit:cockpit-demo";
}

const defaultApiPort = 3000;
const defaultDbPort = 55439;

function portValue(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d{0,4}$/.test(raw)) throw new Error(`${name} must be a valid port`);
  const value = Number(raw);
  if (value > 65535) throw new Error(`${name} must be a valid port`);
  return value;
}

export function resolveCockpitDemoInstance(
  env: Record<string, string | undefined>,
  root: string,
): CockpitDemoInstance {
  const id = env.SUBKIT_DEMO_INSTANCE ?? null;
  if (id !== null && !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(id))
    throw new Error(
      "SUBKIT_DEMO_INSTANCE must be a lowercase ID with letters, digits, and hyphens",
    );
  const apiPort = portValue("SUBKIT_TEST_PORT", env.SUBKIT_TEST_PORT, defaultApiPort);
  const dbPort = portValue("SUBKIT_DEMO_DB_PORT", env.SUBKIT_DEMO_DB_PORT, defaultDbPort);
  if (id && (apiPort === defaultApiPort || dbPort === defaultDbPort))
    throw new Error("Named demo instances require dedicated non-default API and database ports");
  if (apiPort === dbPort) throw new Error("SUBKIT_DEMO_DB_PORT must differ from SUBKIT_TEST_PORT");
  return {
    id,
    project: id ? `subkit-cockpit-demo-${id}` : "subkit-cockpit-demo",
    apiPort,
    dbPort,
    baseUrl: `http://127.0.0.1:${apiPort}`,
    stateDir: resolve(root, ".artifacts", "cockpit-demo", ...(id ? [id] : [])),
  };
}

export function cockpitDemoBaseUrl(instance: CockpitDemoInstance, override?: string): URL {
  const base = new URL(override ?? instance.baseUrl);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    Number(base.port || "80") !== instance.apiPort
  )
    throw new Error("Local demo verification URL does not match the selected loopback instance");
  return base;
}

export function cockpitDemoStateDirectory(
  instance: CockpitDemoInstance,
  override: string | undefined,
): string {
  if (override !== undefined && resolve(override) !== instance.stateDir)
    throw new Error("SUBKIT_DEMO_STATE_DIR must match the selected local demo instance");
  return instance.stateDir;
}

export function cockpitDemoMarker(
  instance: CockpitDemoInstance,
  image: string,
  source: string,
): CockpitDemoMarker {
  if (!image || !source)
    throw new Error("Demo instance marker requires image and source fingerprints");
  return {
    schema: "subkit-cockpit-demo-instance-v1",
    instanceId: instance.id,
    project: instance.project,
    apiPort: instance.apiPort,
    dbPort: instance.dbPort,
    image,
    source,
  };
}

export function assertCockpitDemoMarker(
  marker: unknown,
  expected: CockpitDemoInstance,
): asserts marker is CockpitDemoMarker {
  if (!marker || typeof marker !== "object")
    throw new Error(
      "Local demo instance marker is missing or invalid; refusing to touch Docker resources",
    );
  const value = marker as Partial<CockpitDemoMarker>;
  if (
    value.schema !== "subkit-cockpit-demo-instance-v1" ||
    value.instanceId !== expected.id ||
    value.project !== expected.project ||
    value.apiPort !== expected.apiPort ||
    value.dbPort !== expected.dbPort ||
    typeof value.image !== "string" ||
    value.image.length === 0 ||
    typeof value.source !== "string" ||
    value.source.length === 0
  )
    throw new Error(
      "Local demo instance marker does not match the selected instance; refusing to touch Docker resources",
    );
}

export function assertCockpitDemoActionMarker(
  args: ReadonlySet<string>,
  marker: unknown,
  expected: CockpitDemoInstance,
): void {
  if (args.has("--reset") || args.has("--stop") || args.has("--restart"))
    assertCockpitDemoMarker(marker, expected);
}

export function readCockpitDemoMarker(instance: CockpitDemoInstance): CockpitDemoMarker | null {
  const path = join(instance.stateDir, "instance.json");
  let file: ReturnType<typeof lstatSync>;
  try {
    file = lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw new Error(
      "Local demo instance marker cannot be inspected; refusing to touch Docker resources",
    );
  }
  if (!file.isFile() || file.nlink !== 1)
    throw new Error(
      "Local demo instance marker must be a standalone regular file; refusing to touch Docker resources",
    );
  try {
    chmodSync(path, 0o600);
    return JSON.parse(readFileSync(path, "utf8")) as CockpitDemoMarker;
  } catch {
    throw new Error("Local demo instance marker is unreadable; refusing to touch Docker resources");
  }
}

export function cockpitDemoEngineNeedsRecreate(runningImage: string, builtImage: string): boolean {
  return builtImage !== "" && runningImage !== builtImage;
}
