import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import { getConfig, loadConfig } from "../config/loader.ts";
import { type Config, ConfigSchema } from "../config/schema.ts";
import { closeDb, type Db, type Executor, getDb } from "../db/client.ts";
import { runMigrationsFromUrl } from "../db/migrate.ts";
import { auditLog } from "../db/schema/audit.ts";
import { executionFixtures, executionSteps, executions, files } from "../db/schema/index.ts";
import { type ObjectStore, S3ObjectStore } from "../storage/object-store.ts";
import { configDigest } from "./document.ts";
import {
  getRuntimeConfigState,
  initializeRuntimeConfig,
  RuntimeConfigNotFoundError,
} from "./service.ts";

const BRIDGE_LOCK_KEY = 776_644_2044;

type JsonObject = Record<string, unknown>;

export interface LegacyStoreBinding {
  bucket: string;
  store: ObjectStore;
}

export interface LegacyBridgeSources {
  files?: LegacyStoreBinding;
  offload?: LegacyStoreBinding;
}

export interface StatelessBridgeReport {
  files: { scanned: number; migrated: number; verified: number };
  offloads: { scanned: number; migrated: number; verified: number };
}

interface StreamSource {
  size: number;
  open(): Promise<AsyncIterable<Uint8Array>>;
}

function cliOption(argv: string[], name: string): string | undefined {
  const equals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function loadBootstrapConfig(): Promise<Config> {
  await loadConfig();
  const config = getConfig();
  const { reconfigureLogger, reconfigureObservability } = await import("../logging/logger.ts");
  reconfigureLogger({ level: config.log.level, format: config.log.format });
  reconfigureObservability({
    field_truncation_chars: config.observability.field_truncation_chars,
    service_name: config.observability.otlp.service_name,
    deployment_environment: config.observability.deployment_environment,
  });
  return config;
}

/** CLI orchestration for the explicit one-shot recovery bridge. Normal boot
 * never imports this module. */
export async function runStatelessBridgeCli(argv: string[]): Promise<StatelessBridgeReport> {
  const legacyConfig = cliOption(argv, "--legacy-config")?.trim();
  const legacyFilesDir = cliOption(argv, "--legacy-files-dir")?.trim();
  if (!legacyConfig) throw new Error("--legacy-config is required");

  const legacy = await readLegacyConfig(legacyConfig);
  const bootstrapConfig = await loadBootstrapConfig();
  await runMigrationsFromUrl(bootstrapConfig.database.url);
  const db = getDb();
  const translated = translateLegacyConfig(legacy, bootstrapConfig);
  const markerExists = await hasConfigBridgeMarker(db);
  let existedBeforeBridge = true;
  try {
    await getRuntimeConfigState(db);
  } catch (error) {
    if (!(error instanceof RuntimeConfigNotFoundError)) throw error;
    existedBeforeBridge = false;
  }

  const state = await initializeRuntimeConfig(db, translated);
  if (existedBeforeBridge && !markerExists && !configsMatch(getConfig(), translated)) {
    throw new Error(
      "stateless bridge refused to import over an existing, different runtime configuration",
    );
  }

  const { getObjectStore } = await import("../storage/object-store.ts");
  const activeConfig = getConfig();
  const report = await bridgeLegacyObjects(db, {
    destination: getObjectStore(),
    destinationBucket: activeConfig.storage.object_store.bucket,
    legacyFilesDir: legacyFilesDir || defaultLegacyFilesDir(legacyConfig),
    sources: legacySourcesFromConfig(legacy),
  });
  await recordConfigBridgeMarker(db, translated, legacyConfig, state.active_revision);
  await closeDb();
  return report;
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Preserve every still-supported legacy setting while making the bootstrap
 * database URL, listen port, and destination object-store binding
 * authoritative. Retired storage sections are source credentials only and
 * never land in the new runtime revision.
 */
export function translateLegacyConfig(raw: unknown, bootstrap: Config): Config {
  const legacy = clone(asObject(raw));
  const legacyDatabase = asObject(legacy.database);
  const legacyServer = asObject(legacy.server);
  return ConfigSchema.parse({
    ...legacy,
    database: { ...legacyDatabase, url: bootstrap.database.url },
    server: { ...legacyServer, port: bootstrap.server.port },
    storage: clone(bootstrap.storage),
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function legacyS3Binding(args: {
  endpoint: string | undefined;
  region: string | undefined;
  bucket: string | undefined;
  accessKey: string | undefined;
  secretKey: string | undefined;
}): LegacyStoreBinding | undefined {
  if (!args.bucket || !args.accessKey || !args.secretKey) return undefined;
  return {
    bucket: args.bucket,
    store: new S3ObjectStore({
      endpoint: args.endpoint || "https://s3.amazonaws.com",
      region: args.region || "us-east-1",
      bucket: args.bucket,
      access_key_id: args.accessKey,
      secret_access_key: args.secretKey,
      force_path_style: Boolean(args.endpoint),
    }),
  };
}

/** Build read-only source bindings from the retired v6 storage shape. */
export function legacySourcesFromConfig(raw: unknown): LegacyBridgeSources {
  const storage = asObject(asObject(raw).storage);
  const shared = asObject(storage.s3);
  const legacyFiles = asObject(storage.files);
  const offload = asObject(storage.offload);
  const filesBinding = legacyS3Binding({
    endpoint: optionalString(shared.endpoint),
    region: undefined,
    bucket: optionalString(legacyFiles.bucket),
    accessKey: optionalString(shared.access_key),
    secretKey: optionalString(shared.secret_key),
  });
  const offloadBinding = legacyS3Binding({
    endpoint: optionalString(offload.endpoint),
    region: optionalString(offload.region),
    bucket: optionalString(offload.bucket),
    accessKey: optionalString(offload.access_key),
    secretKey: optionalString(offload.secret_key),
  });
  return {
    ...(filesBinding ? { files: filesBinding } : {}),
    ...(offloadBinding ? { offload: offloadBinding } : {}),
  };
}

function parseStorageUri(uri: string): {
  scheme: string;
  bucket?: string;
  key: string;
} {
  const marker = uri.indexOf("://");
  if (marker < 0) return { scheme: "local", key: uri };
  const scheme = uri.slice(0, marker);
  const tail = uri.slice(marker + 3);
  if (scheme !== "s3") return { scheme, key: tail.split("?", 1)[0]! };
  const slash = tail.indexOf("/");
  if (slash < 1) throw new Error("bridge: malformed s3 storage URI");
  return { scheme, bucket: tail.slice(0, slash), key: tail.slice(slash + 1) };
}

function safeLocalPath(root: string, encodedKey: string): string {
  let key: string;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    throw new Error("bridge: legacy local storage URI is not valid percent-encoding");
  }
  if (!key || key.includes("\0")) throw new Error("bridge: invalid legacy local storage key");
  const base = resolve(root);
  const target = resolve(base, key);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error("bridge: legacy local storage key escapes its configured root");
  }
  return target;
}

async function localSource(root: string, key: string): Promise<StreamSource> {
  const path = safeLocalPath(root, key);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("bridge: legacy local object is not a regular file");
  return {
    size: metadata.size,
    async open() {
      return createReadStream(path) as unknown as AsyncIterable<Uint8Array>;
    },
  };
}

async function objectSource(store: ObjectStore, key: string): Promise<StreamSource> {
  const head = await store.head(key);
  if (!head) throw new Error("bridge: source object is missing");
  return { size: head.size, open: () => store.openRead(key) };
}

function bytesSource(bytes: Uint8Array): StreamSource {
  return {
    size: bytes.byteLength,
    async open() {
      return (async function* () {
        yield bytes;
      })();
    },
  };
}

async function sha256(source: StreamSource): Promise<string> {
  const hash = createHash("sha256");
  let seen = 0;
  for await (const chunk of await source.open()) {
    seen += chunk.byteLength;
    hash.update(chunk);
  }
  if (seen !== source.size) {
    throw new Error(`bridge: source length ${seen} does not match expected ${source.size}`);
  }
  return hash.digest("hex");
}

async function ensureDestination(
  destination: ObjectStore,
  key: string,
  source: StreamSource,
  expectedSha256: string,
): Promise<"migrated" | "verified"> {
  const existing = await destination.head(key);
  if (!existing) {
    await destination.putStream(key, await source.open(), source.size);
  } else if (existing.size !== source.size) {
    throw new Error("bridge: immutable destination object has an unexpected size");
  }
  const after = await destination.head(key);
  if (!after || after.size !== source.size) {
    throw new Error("bridge: destination HeadObject verification failed");
  }
  const destinationSha = await sha256(await objectSource(destination, key));
  if (destinationSha !== expectedSha256) {
    throw new Error("bridge: destination SHA-256 verification failed");
  }
  return existing ? "verified" : "migrated";
}

async function sourceForUri(args: {
  uri: string;
  destination: ObjectStore;
  destinationBucket: string;
  legacyFilesDir: string;
  sourceBinding: LegacyStoreBinding | undefined;
}): Promise<StreamSource> {
  const parsed = parseStorageUri(args.uri);
  if (parsed.scheme === "local") return localSource(args.legacyFilesDir, parsed.key);
  if (parsed.scheme === "s3") {
    if (parsed.bucket === args.destinationBucket) {
      return objectSource(args.destination, parsed.key);
    }
    if (!args.sourceBinding || args.sourceBinding.bucket !== parsed.bucket) {
      throw new Error("bridge: no matching legacy S3 source binding for object URI");
    }
    return objectSource(args.sourceBinding.store, parsed.key);
  }
  throw new Error(`bridge: unsupported legacy object scheme ${parsed.scheme}`);
}

async function auditObject(
  tx: Executor,
  args: {
    tenantId: string;
    resourceType: "file" | "execution_offload";
    resourceId: string;
    sourceScheme: string;
    destinationKey: string;
    size: number;
    sha: string;
  },
): Promise<void> {
  await auditAwait(
    {
      tenant_id: args.tenantId,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.STATELESS_BRIDGE_OBJECT_MIGRATED,
      resource_type: args.resourceType,
      resource_id: args.resourceId,
      metadata: {
        source_scheme: args.sourceScheme,
        destination_key_sha256: createHash("sha256").update(args.destinationKey).digest("hex"),
        size_bytes: args.size,
        content_sha256: args.sha,
      },
    },
    tx,
  );
}

/**
 * Idempotently copy legacy local/S3 files and PostgreSQL offload fixtures to
 * the destination bucket, verify length + application SHA-256, then switch
 * PostgreSQL pointers in one transaction. Source rows and files remain intact
 * for rollback; the stateless runtime never writes new fixture:// pointers.
 */
export async function bridgeLegacyObjects(
  db: Db,
  args: {
    destination: ObjectStore;
    destinationBucket: string;
    legacyFilesDir: string;
    sources?: LegacyBridgeSources;
  },
): Promise<StatelessBridgeReport> {
  await args.destination.headBucket();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BRIDGE_LOCK_KEY})`);
    const report: StatelessBridgeReport = {
      files: { scanned: 0, migrated: 0, verified: 0 },
      offloads: { scanned: 0, migrated: 0, verified: 0 },
    };

    // tenant-filter:exempt — maintenance bridge scans every product-owned row;
    // every update below still carries the row's tenant_id predicate.
    const fileRows = await tx.select().from(files);
    for (const row of fileRows) {
      report.files.scanned += 1;
      const parsed = parseStorageUri(row.storage_uri);
      const source = await sourceForUri({
        uri: row.storage_uri,
        destination: args.destination,
        destinationBucket: args.destinationBucket,
        legacyFilesDir: args.legacyFilesDir,
        sourceBinding: args.sources?.files,
      });
      const sha = await sha256(source);
      const alreadyCanonical = parsed.scheme === "s3" && parsed.bucket === args.destinationBucket;
      const destinationKey = alreadyCanonical
        ? parsed.key
        : `bridge/files/${row.tenant_id}/${row.id}/${sha}`;
      const outcome = await ensureDestination(args.destination, destinationKey, source, sha);
      report.files[outcome] += 1;
      const destinationUri = `s3://${args.destinationBucket}/${destinationKey}`;
      if (
        row.storage_uri !== destinationUri ||
        row.size_bytes !== source.size ||
        row.sha256 !== sha
      ) {
        await tx
          .update(files)
          .set({
            storage_uri: destinationUri,
            size_bytes: source.size,
            sha256: sha,
            updated_at: new Date(),
          })
          .where(and(eq(files.id, row.id), eq(files.tenant_id, row.tenant_id)));
        await auditObject(tx, {
          tenantId: row.tenant_id,
          resourceType: "file",
          resourceId: row.id,
          sourceScheme: parsed.scheme,
          destinationKey,
          size: source.size,
          sha,
        });
      }
    }

    // tenant-filter:exempt — product-global maintenance scan; pointer updates
    // below are constrained by tenant_id plus the exact legacy URI.
    const fixtureRows = await tx
      .select()
      .from(executionFixtures)
      .where(eq(executionFixtures.kind, "offload"));
    for (const fixture of fixtureRows) {
      report.offloads.scanned += 1;
      if (fixture.body === null || fixture.body === undefined) {
        throw new Error(`bridge: offload fixture ${fixture.id} has no body`);
      }
      const bytes = Buffer.from(JSON.stringify(fixture.body), "utf8");
      const source = bytesSource(bytes);
      const sha = await sha256(source);
      const destinationKey = `bridge/offload/${fixture.tenant_id}/${fixture.id}/${sha}.json`;
      const outcome = await ensureDestination(args.destination, destinationKey, source, sha);
      report.offloads[outcome] += 1;
      const legacyUri = `fixture://${fixture.id}`;
      const destinationUri = `s3://${args.destinationBucket}/${destinationKey}`;
      const updatedSteps = await tx
        .update(executionSteps)
        .set({ result_storage_uri: destinationUri, result_sha256: sha })
        .where(
          and(
            eq(executionSteps.tenant_id, fixture.tenant_id),
            eq(executionSteps.result_storage_uri, legacyUri),
          ),
        )
        .returning({ id: executionSteps.id });
      const updatedExecutions = await tx
        .update(executions)
        .set({ result_storage_uri: destinationUri, result_sha256: sha })
        .where(
          and(
            eq(executions.tenant_id, fixture.tenant_id),
            eq(executions.result_storage_uri, legacyUri),
          ),
        )
        .returning({ id: executions.id });
      if (updatedSteps.length + updatedExecutions.length > 0) {
        await auditObject(tx, {
          tenantId: fixture.tenant_id,
          resourceType: "execution_offload",
          resourceId: fixture.id,
          sourceScheme: "fixture",
          destinationKey,
          size: source.size,
          sha,
        });
      }
    }

    // Legacy deployments may already point at a different S3 offload bucket.
    // tenant-filter:exempt — maintenance scan; each update is tenant-bound.
    const [stepRows, executionRows] = await Promise.all([
      tx
        .select({
          id: executionSteps.id,
          tenant_id: executionSteps.tenant_id,
          uri: executionSteps.result_storage_uri,
        })
        .from(executionSteps),
      tx
        .select({
          id: executions.id,
          tenant_id: executions.tenant_id,
          uri: executions.result_storage_uri,
        })
        .from(executions),
    ]);
    const legacyS3 = new Map<string, { tenantId: string; resourceId: string }>();
    for (const row of [...stepRows, ...executionRows]) {
      if (!row.uri?.startsWith("s3://")) continue;
      const parsed = parseStorageUri(row.uri);
      if (parsed.bucket === args.destinationBucket) continue;
      legacyS3.set(row.uri, { tenantId: row.tenant_id, resourceId: row.id });
    }
    for (const [uri, identity] of legacyS3) {
      report.offloads.scanned += 1;
      const source = await sourceForUri({
        uri,
        destination: args.destination,
        destinationBucket: args.destinationBucket,
        legacyFilesDir: args.legacyFilesDir,
        sourceBinding: args.sources?.offload,
      });
      const sha = await sha256(source);
      const destinationKey = `bridge/offload/${identity.tenantId}/${sha}.json`;
      const outcome = await ensureDestination(args.destination, destinationKey, source, sha);
      report.offloads[outcome] += 1;
      const destinationUri = `s3://${args.destinationBucket}/${destinationKey}`;
      await tx
        .update(executionSteps)
        .set({ result_storage_uri: destinationUri, result_sha256: sha })
        .where(
          and(
            eq(executionSteps.tenant_id, identity.tenantId),
            eq(executionSteps.result_storage_uri, uri),
          ),
        );
      await tx
        .update(executions)
        .set({ result_storage_uri: destinationUri, result_sha256: sha })
        .where(
          and(eq(executions.tenant_id, identity.tenantId), eq(executions.result_storage_uri, uri)),
        );
      await auditObject(tx, {
        tenantId: identity.tenantId,
        resourceType: "execution_offload",
        resourceId: identity.resourceId,
        sourceScheme: "s3",
        destinationKey,
        size: source.size,
        sha,
      });
    }

    await auditAwait(
      {
        tenant_id: SYSTEM_TENANT_ID,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.STATELESS_BRIDGE_COMPLETED,
        resource_type: "stateless_bridge",
        resource_id: "subkit",
        metadata: { ...report },
      },
      tx,
    );
    return report;
  });
}

export async function hasConfigBridgeMarker(db: Executor): Promise<boolean> {
  // tenant-filter:exempt — singleton product migration marker.
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, SYSTEM_TENANT_ID),
        eq(auditLog.action, AuditAction.STATELESS_BRIDGE_CONFIG_IMPORTED),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function recordConfigBridgeMarker(
  db: Executor,
  config: Config,
  legacyConfigPath: string,
  revision = 1,
): Promise<void> {
  if (await hasConfigBridgeMarker(db)) return;
  await auditAwait(
    {
      tenant_id: SYSTEM_TENANT_ID,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.STATELESS_BRIDGE_CONFIG_IMPORTED,
      resource_type: "runtime_config_revision",
      resource_id: String(revision),
      metadata: {
        config_digest: configDigest(config),
        source_path_sha256: createHash("sha256").update(resolve(legacyConfigPath)).digest("hex"),
      },
    },
    db,
  );
}

export async function readLegacyConfig(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export function defaultLegacyFilesDir(configPath: string): string {
  return resolve(dirname(configPath), "..", "blobs");
}

export function configsMatch(a: Config, b: Config): boolean {
  return configDigest(a) === configDigest(b);
}
