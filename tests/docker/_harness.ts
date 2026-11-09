import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import pg from "pg";
import { loadEmbeddedKnowledgeSeeds } from "../../apps/engine/src/knowledge/seed.ts";
import { loadEmbeddedSkillSeeds } from "../../apps/engine/src/skills/seed.ts";
import type { CommandResult } from "../e2e/_helpers.ts";
import { resolveBootstrapIdentity } from "./_bootstrap-identity.ts";
import {
  buildFreshImage,
  cleanupDockerTestRun,
  createDockerTestRun,
  DOCKER_STOP_TIMEOUT_SECONDS,
  type DockerTestRun,
  runEnv,
  withPublishedPorts,
} from "./_run.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const COMPOSE_FILE = "docker-compose.test.yml";
const SERVICE = "engine";
const TEST_BOOTSTRAP_KEY = "b".repeat(64);
const DOCKER_ENV = {
  ...process.env,
  DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? path.join(userInfo().homedir, ".docker"),
};

export function createDockerHarnessRunLifecycle(
  create: () => DockerTestRun,
  build: (run: DockerTestRun) => DockerTestRun,
) {
  let current: DockerTestRun | undefined;
  let failure: { error: unknown } | undefined;
  return {
    run(): DockerTestRun {
      if (failure) throw failure.error;
      if (!current) {
        const created = create();
        current = created;
        try {
          current = build(created);
        } catch (error) {
          failure = { error };
          throw error;
        }
      }
      return current;
    },
    existingRun(): DockerTestRun | undefined {
      return current;
    },
  };
}

const dockerRunLifecycle = createDockerHarnessRunLifecycle(
  () => {
    const managed = Boolean(process.env.SUBKIT_DOCKER_PROJECT && process.env.SUBKIT_TEST_IMAGE);
    return createDockerTestRun(managed ? "managed" : "standalone");
  },
  (run) => {
    const managed = Boolean(process.env.SUBKIT_DOCKER_PROJECT && process.env.SUBKIT_TEST_IMAGE);
    return managed ? run : buildFreshImage(run);
  },
);

function dockerRun(): DockerTestRun {
  return dockerRunLifecycle.run();
}

function resolvePort(service: string, containerPort: string): string {
  const published = compose(["port", service, containerPort]);
  const match = `${published.stdout}\n${published.stderr}`.match(/:(\d+)\s*$/m);
  if (published.status !== 0 || !match)
    throw new Error(`could not resolve ${service}:${containerPort} host port`);
  return match[1]!;
}

function resolvePublishedPorts(): void {
  const run = dockerRun();
  Object.assign(
    run,
    withPublishedPorts(run, resolvePort(SERVICE, "3000"), resolvePort("postgres", "5432")),
  );
}

function dockerBaseUrl(): string {
  return dockerRun().baseUrl;
}

async function waitForDockerHealth(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`${dockerBaseUrl()}/health`);
      const ready = await fetch(`${dockerBaseUrl()}/ready`);
      const body = (await ready.json()) as {
        status?: string;
        checks?: { database?: string };
      };
      if (health.ok && ready.ok && body.status === "ready" && body.checks?.database === "pass")
        return;
    } catch {}
    await Bun.sleep(2_000);
  }
  throw new Error(`engine at ${dockerBaseUrl()} did not become healthy within ${timeoutMs}ms`);
}

export function compose(args: string[], extraEnv?: Record<string, string>): CommandResult {
  const run = dockerRun();
  return composeForRun(run, args, extraEnv);
}

function composeForRun(
  run: DockerTestRun,
  args: string[],
  extraEnv?: Record<string, string>,
): CommandResult {
  const result = spawnSync("docker", ["compose", "-p", run.project, "-f", COMPOSE_FILE, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...DOCKER_ENV, ...runEnv(run), ...extraEnv },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function composeUp(): Promise<void> {
  const previousEngine = compose(["ps", "-q", SERVICE]).stdout.trim();
  const up = compose(["up", "-d", "--wait"]);
  if (up.status !== 0) {
    throw new Error(`compose up failed (${up.status}):\n${up.stdout}\n${up.stderr}`);
  }
  const currentEngine = compose(["ps", "-q", SERVICE]).stdout.trim();
  if (previousEngine && previousEngine !== currentEngine)
    throw new Error("warm scenario unexpectedly replaced its engine between test files");
  resolvePublishedPorts();
  await waitForDockerHealth();
}

export function composeDown(): void {
  if (process.env.SUBKIT_DOCKER_MANAGED === "1" || process.env.SUBKIT_DOCKER_KEEP_ALIVE === "1")
    return;
  const run = dockerRunLifecycle.existingRun();
  if (!run) return;
  const result = cleanupDockerTestRun(run);
  if (result.cleanupFailed || result.profileCaptureFailed)
    throw new Error("Docker cleanup or profile capture failed");
}

export async function replaceEngineContainer(): Promise<string> {
  compose(["stop", "--timeout", String(DOCKER_STOP_TIMEOUT_SECONDS), SERVICE]);
  const artifactDir = path.join(tmpdir(), `subkit-docker-artifacts-${dockerRun().project}`);
  mkdirSync(artifactDir, { recursive: true });
  collectContainerLogs(path.join(artifactDir, "engine-before-recreate.log"));
  const predecessor = compose(["ps", "--all", "-q", SERVICE]).stdout.trim();
  if (predecessor) {
    spawnSync(
      "docker",
      [
        "cp",
        `${predecessor}:/tmp/subkit-profiles/.`,
        path.join(artifactDir, "profiles-before-recreate"),
      ],
      { cwd: REPO_ROOT, env: DOCKER_ENV, encoding: "utf8" },
    );
  }
  const replaced = compose(["up", "-d", "--force-recreate", "--no-deps", "--wait", SERVICE]);
  if (replaced.status !== 0) {
    throw new Error(
      `engine replacement failed (${replaced.status}):\n${replaced.stdout}\n${replaced.stderr}`,
    );
  }
  resolvePublishedPorts();
  await waitForDockerHealth();
  return dockerBaseUrl();
}

export function engineMounts(): Array<{ Destination?: string; Type?: string }> {
  const id = compose(["ps", "-q", SERVICE]).stdout.trim();
  if (!id) throw new Error("engine container id is unavailable");
  const inspected = spawnSync("docker", ["inspect", "--format", "{{json .Mounts}}", id], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: DOCKER_ENV,
  });
  if (inspected.status !== 0) {
    throw new Error(`docker inspect failed: ${inspected.stderr ?? "unknown error"}`);
  }
  return JSON.parse(inspected.stdout || "[]") as Array<{
    Destination?: string;
    Type?: string;
  }>;
}

export function collectContainerLogs(dest: string): void {
  const run = dockerRunLifecycle.existingRun();
  if (!run) return;
  const logs = composeForRun(run, ["logs", "--no-color", SERVICE]);
  Bun.write(dest, `${logs.stdout}\n${logs.stderr}`);
}

export interface BootstrapResult {
  adminKey: string;
  tenantId: string;
  tenantSlug: string;
}

function parseIssuedKey(text: string): string | null {
  return text.match(/wf_live_[A-Za-z0-9_-]+/)?.[0] ?? null;
}

export async function bootstrapAdminKey(): Promise<BootstrapResult> {
  const provided = process.env.SUBKIT_DOCKER_API_KEY;
  if (provided) {
    return { adminKey: provided, ...(await resolveBootstrapIdentity(dockerBaseUrl(), provided)) };
  }

  const status = await fetch(`${dockerBaseUrl()}/v1/bootstrap/status`).then(
    (r) => r.json() as Promise<{ pending: boolean }>,
  );

  if (status.pending) {
    const res = await fetch(`${dockerBaseUrl()}/v1/bootstrap/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: TEST_BOOTSTRAP_KEY,
        admin_email: "admin@docker-e2e.local",
        tenant_name: "default",
        llm_provider: "mock",
        llm_api_key: "mock",
      }),
    });
    if (res.status === 200) {
      const body = (await res.json()) as { api_key: string; tenant_id: string };
      return {
        adminKey: body.api_key,
        tenantId: body.tenant_id,
        tenantSlug: "default",
      };
    }
    if (res.status !== 410) {
      throw new Error(`POST /v1/bootstrap/complete failed: ${res.status} ${await res.text()}`);
    }
  }

  const issued = issueAdminKeyViaExec("default");
  const key = parseIssuedKey(`${issued.stdout}\n${issued.stderr}`);
  if (!key) {
    throw new Error(`issue-admin-key produced no key:\n${issued.stdout}\n${issued.stderr}`);
  }
  return { adminKey: key, ...(await resolveBootstrapIdentity(dockerBaseUrl(), key)) };
}

export interface DockerEnv {
  baseUrl: string;
  adminKey: string;
  tenantId: string;
  tenantSlug: string;
}

export async function dockerBoot(): Promise<DockerEnv> {
  await composeUp();
  const boot = await bootstrapAdminKey();
  return { baseUrl: dockerBaseUrl(), ...boot };
}

export interface SkResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function skDocker(
  env: DockerEnv,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<SkResult> {
  const proc = Bun.spawn(
    [
      "docker",
      "compose",
      "-p",
      dockerRun().project,
      "-f",
      COMPOSE_FILE,
      "exec",
      "-T",
      "-e",
      "SUBKIT_ENGINE_URL=http://127.0.0.1:3000",
      "-e",
      `SUBKIT_API_KEY=${env.adminKey}`,
      "-e",
      "CI=1",
      "-e",
      "NO_COLOR=1",
      "-e",
      "NO_UPDATE_CHECK=1",
      "-e",
      "SUBKIT_DETERMINISTIC_SEED=1",
      "-e",
      "BUN_OPTIONS=",
      SERVICE,
      "sk",
      ...args,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...DOCKER_ENV,
        ...runEnv(dockerRun()),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => proc.kill(), opts.timeout ?? 30_000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { stdout, stderr, exitCode };
}

export async function dockerApi<T = unknown>(
  env: DockerEnv,
  method: string,
  pathname: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${env.baseUrl}${pathname}`, {
    method,
    ...(signal ? { signal } : {}),
    headers: {
      Authorization: `Bearer ${env.adminKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: T;
  try {
    parsed = text ? (JSON.parse(text) as T) : (null as T);
  } catch {
    parsed = text as unknown as T;
  }
  return { status: res.status, body: parsed };
}

export function issueAdminKeyViaExec(tenantSlug = "default"): CommandResult {
  return compose([
    "exec",
    "-T",
    "-e",
    "BUN_OPTIONS=",
    SERVICE,
    "engine",
    "--issue-admin-key",
    "--tenant",
    tenantSlug,
  ]);
}

export function containerDatabaseUrl(): string {
  const port = dockerRun().publishedDbPort;
  if (!port) throw new Error("test database port has not been resolved");
  return `postgres://subkit:subkit-test@127.0.0.1:${port}/subkit`;
}

export interface SeedStateReceipt {
  state: "natural" | "unchanged" | "changed";
  skills: SeedCollectionReceipt;
  knowledge: SeedCollectionReceipt;
  changedKnowledgeSlug?: string;
  changedKnowledgeChunkIds?: string[];
}

interface SeedCollectionReceipt {
  count: number;
  digest: string;
}

function seedDigest(rows: Array<{ slug: string; version: string }>): SeedCollectionReceipt {
  return {
    count: rows.length,
    digest: createHash("sha256")
      .update(
        [...rows]
          .sort((a, b) => a.slug.localeCompare(b.slug))
          .map((row) => `${row.slug}:${row.version}`)
          .join("\n"),
      )
      .digest("hex"),
  };
}
export async function prepareRestartSeedState(): Promise<SeedStateReceipt> {
  const state: SeedStateReceipt["state"] =
    process.env.SUBKIT_DOCKER_SEED_STATE === "changed"
      ? "changed"
      : process.env.SUBKIT_DOCKER_SEED_STATE === "unchanged"
        ? "unchanged"
        : "natural";
  const client = new pg.Client({ connectionString: containerDatabaseUrl() });
  await client.connect();
  try {
    const tenant = await client.query<{ id: string }>(
      `SELECT id FROM subkit.tenants WHERE slug='default' AND status='active' AND deleted_at IS NULL`,
    );
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error("default tenant is unavailable for restart fixture");

    if (state === "natural") {
      const skills = await client.query<{ slug: string; version: string }>(
        `SELECT slug, seed_source AS version FROM subkit.skills WHERE tenant_id=$1 AND source='template' AND seed_source IS NOT NULL ORDER BY slug`,
        [tenantId],
      );
      const knowledge = await client.query<{ slug: string; version: string }>(
        `SELECT slug, version FROM subkit.knowledge_sources WHERE tenant_id=$1 AND source_type='seed' AND deleted_at IS NULL ORDER BY slug`,
        [tenantId],
      );
      return { state, skills: seedDigest(skills.rows), knowledge: seedDigest(knowledge.rows) };
    }

    await replaceEngineContainer();
    const expectedSkillCount = loadEmbeddedSkillSeeds().skills.length;
    const expectedKnowledgeCount = loadEmbeddedKnowledgeSeeds().knowledge.length;
    const deadline = Date.now() + 120_000;
    while (true) {
      const ready = await client.query<{ skills: string; knowledge: string; chunked: string }>(
        `SELECT
          (SELECT count(*) FROM subkit.skills WHERE tenant_id=$1 AND source='template') AS skills,
          (SELECT count(*) FROM subkit.knowledge_sources WHERE tenant_id=$1 AND source_type='seed' AND deleted_at IS NULL) AS knowledge,
          (SELECT count(DISTINCT c.knowledge_source_id) FROM subkit.knowledge_chunks c
             JOIN subkit.knowledge_sources s ON s.id=c.knowledge_source_id
             WHERE s.tenant_id=$1 AND s.source_type='seed' AND s.deleted_at IS NULL) AS chunked`,
        [tenantId],
      );
      const row = ready.rows[0];
      if (
        Number(row?.skills) === expectedSkillCount &&
        Number(row?.knowledge) === expectedKnowledgeCount &&
        Number(row?.chunked) === expectedKnowledgeCount
      )
        break;
      if (Date.now() >= deadline)
        throw new Error("fixture setup did not finish production seed ingestion");
      await Bun.sleep(200);
    }
    const seededSkill = await client.query<{ id: string }>(
      `SELECT id FROM subkit.skills WHERE tenant_id=$1 AND source='template' ORDER BY id LIMIT 1`,
      [tenantId],
    );
    if (!seededSkill.rows[0]?.id) throw new Error("skill seed fixture was not created");
    let changedKnowledgeSlug: string | undefined;
    let changedKnowledgeChunkIds: string[] | undefined;
    if (state === "changed")
      await client.query(
        `UPDATE subkit.skills SET seed_source='fixture-stale-' || seed_source WHERE id=$1`,
        [seededSkill.rows[0].id],
      );
    if (state === "changed")
      changedKnowledgeSlug = (
        await client.query<{ slug: string }>(
          `UPDATE subkit.knowledge_sources SET version='fixture-stale-' || version
         WHERE id = (SELECT id FROM subkit.knowledge_sources
                     WHERE tenant_id=$1 AND source_type='seed' AND deleted_at IS NULL
                     ORDER BY slug LIMIT 1)
         RETURNING slug`,
          [tenantId],
        )
      ).rows[0]?.slug;
    if (changedKnowledgeSlug) {
      const chunks = await client.query<{ id: string }>(
        `SELECT c.id FROM subkit.knowledge_chunks c JOIN subkit.knowledge_sources s ON s.id=c.knowledge_source_id
         WHERE s.tenant_id=$1 AND s.slug=$2 ORDER BY c.id`,
        [tenantId, changedKnowledgeSlug],
      );
      changedKnowledgeChunkIds = chunks.rows.map((row) => row.id);
    }
    const skills = await client.query<{ slug: string; version: string }>(
      `SELECT slug, seed_source AS version FROM subkit.skills WHERE tenant_id=$1 AND source='template' AND seed_source IS NOT NULL ORDER BY slug`,
      [tenantId],
    );
    const knowledge = await client.query<{ slug: string; version: string }>(
      `SELECT slug, version FROM subkit.knowledge_sources WHERE tenant_id=$1 AND source_type='seed' AND deleted_at IS NULL ORDER BY slug`,
      [tenantId],
    );
    const receipt = {
      state,
      skills: seedDigest(skills.rows),
      knowledge: seedDigest(knowledge.rows),
      ...(changedKnowledgeSlug ? { changedKnowledgeSlug } : {}),
      ...(changedKnowledgeChunkIds ? { changedKnowledgeChunkIds } : {}),
    };
    return receipt;
  } finally {
    await client.end();
  }
}

function pendingSeedReceiptPath(): string {
  return path.join(tmpdir(), `subkit-seed-state-${dockerRun().project}.json`);
}

interface PendingSeedReceipt {
  project: string;
  run_id: string;
  image_id: string;
  receipt: SeedStateReceipt;
}

async function awaitRestartSeedState(receipt: SeedStateReceipt): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      await assertRestartSeedState(receipt);
      return;
    } catch (error) {
      if (receipt.state !== "changed" || Date.now() >= deadline) throw error;
      await Bun.sleep(200);
    }
  }
}

export async function finishRestartSeedScenario(receipt: SeedStateReceipt): Promise<void> {
  if (process.env.SUBKIT_DOCKER_KEEP_ALIVE === "1") {
    const run = dockerRun();
    const pending: PendingSeedReceipt = {
      project: run.project,
      run_id: run.runId,
      image_id: run.image,
      receipt,
    };
    writeFileSync(pendingSeedReceiptPath(), JSON.stringify(pending));
    return;
  }
  await awaitRestartSeedState(receipt);
}

export async function finalizePendingSeedScenario(): Promise<void> {
  const file = pendingSeedReceiptPath();
  if (!existsSync(file)) return;
  resolvePublishedPorts();
  const pending = JSON.parse(readFileSync(file, "utf8")) as PendingSeedReceipt;
  const run = dockerRun();
  if (
    pending.project !== run.project ||
    pending.run_id !== run.runId ||
    pending.image_id !== run.image
  )
    throw new Error("pending seed receipt belongs to a different Docker run");
  await awaitRestartSeedState(pending.receipt);
  rmSync(file, { force: true });
}

export async function assertRestartSeedState(receipt: SeedStateReceipt): Promise<void> {
  const client = new pg.Client({ connectionString: containerDatabaseUrl() });
  await client.connect();
  try {
    const tenant = await client.query<{ id: string }>(
      `SELECT id FROM subkit.tenants WHERE slug='default'`,
    );
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error("default tenant disappeared after restart");
    const skills = await client.query<{ slug: string; version: string }>(
      `SELECT slug, seed_source AS version FROM subkit.skills WHERE tenant_id=$1 AND source='template' AND seed_source IS NOT NULL ORDER BY slug`,
      [tenantId],
    );
    const knowledge = await client.query<{ slug: string; version: string }>(
      `SELECT slug, version FROM subkit.knowledge_sources WHERE tenant_id=$1 AND source_type='seed' AND deleted_at IS NULL ORDER BY slug`,
      [tenantId],
    );
    const actual = { skills: seedDigest(skills.rows), knowledge: seedDigest(knowledge.rows) };
    if (receipt.state === "natural") {
      if (
        actual.skills.count < receipt.skills.count ||
        actual.knowledge.count < receipt.knowledge.count
      )
        throw new Error("natural startup lost seed rows during restart");
      process.stdout.write(
        `[docker-seeds] mode=natural skills=${receipt.skills.count}->${actual.skills.count} knowledge=${receipt.knowledge.count}->${actual.knowledge.count}\n`,
      );
      return;
    }
    if (receipt.state === "unchanged") {
      if (
        actual.skills.count !== receipt.skills.count ||
        actual.skills.digest !== receipt.skills.digest ||
        actual.knowledge.count !== receipt.knowledge.count ||
        actual.knowledge.digest !== receipt.knowledge.digest
      )
        throw new Error("unchanged seed fixtures drifted during restart");
    } else if (
      actual.skills.digest === receipt.skills.digest ||
      actual.knowledge.digest === receipt.knowledge.digest
    ) {
      throw new Error("changed seed fixtures were not rewritten during restart");
    }
    const expectedSkills = seedDigest(
      loadEmbeddedSkillSeeds()
        .skills.map((seed) => ({ slug: seed.slug, version: seed.body_hash }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    );
    const expectedKnowledge = seedDigest(
      loadEmbeddedKnowledgeSeeds()
        .knowledge.map((seed) => ({
          slug: seed.slug,
          version: createHash("sha256").update(seed.body).digest("hex").slice(0, 32),
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    );
    if (
      actual.skills.count !== expectedSkills.count ||
      actual.skills.digest !== expectedSkills.digest
    )
      throw new Error(`skill seeds were not reconciled after restart (${receipt.state})`);
    if (
      actual.knowledge.count !== expectedKnowledge.count ||
      actual.knowledge.digest !== expectedKnowledge.digest
    )
      throw new Error(`knowledge seeds were not reconciled after restart (${receipt.state})`);
    if (receipt.state === "changed" && receipt.changedKnowledgeSlug) {
      const chunks = await client.query<{ id: string }>(
        `SELECT c.id FROM subkit.knowledge_chunks c
         JOIN subkit.knowledge_sources s ON s.id=c.knowledge_source_id
         WHERE s.tenant_id=$1 AND s.slug=$2 AND s.source_type='seed'`,
        [tenantId, receipt.changedKnowledgeSlug],
      );
      const before = new Set(receipt.changedKnowledgeChunkIds ?? []);
      if (!chunks.rows.some((row) => !before.has(row.id)))
        throw new Error("changed knowledge seed did not create new chunks after restart");
    }
    process.stdout.write(
      `[docker-seeds] mode=${receipt.state} skills=${receipt.skills.count}->${actual.skills.count} knowledge=${receipt.knowledge.count}->${actual.knowledge.count}\n`,
    );
  } finally {
    await client.end();
  }
}

export interface ScheduleAuthorityPreview {
  manifest: { effects: Array<{ target?: unknown }> };
  digest: string;
}

export async function grantScheduleAuthority(
  _env: DockerEnv,
  workflowId: string,
  versionId: string,
  preview: ScheduleAuthorityPreview,
): Promise<string> {
  const client = new pg.Client({ connectionString: containerDatabaseUrl() });
  await client.connect();
  try {
    const owner = await client.query<{ id: string; tenant_id: string }>(
      `SELECT u.id, u.tenant_id FROM subkit.users u
         JOIN subkit.workflows w ON w.tenant_id = u.tenant_id
         JOIN subkit.roles r ON r.id = u.role_id
        WHERE w.id = $1 AND r.name = 'admin' AND r.is_builtin AND u.deleted_at IS NULL
        ORDER BY u.created_at LIMIT 1`,
      [workflowId],
    );
    const user = owner.rows[0];
    if (!user) throw new Error(`no admin user for the tenant of workflow ${workflowId}`);
    const targets = preview.manifest.effects.flatMap((effect) =>
      effect.target ? [effect.target] : [],
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO subkit.workflow_execution_authorities
         (tenant_id, workflow_id, workflow_version_id, effect_manifest_digest, effect_manifest,
          target_constraints, execution_environment, valid_from, valid_until, max_runs, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'prod', now() - interval '1 minute', now() + interval '1 hour', 3, $7)
       RETURNING id`,
      [
        user.tenant_id,
        workflowId,
        versionId,
        preview.digest,
        JSON.stringify(preview.manifest),
        JSON.stringify({ targets }),
        user.id,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("authority insert returned no row");
    await client.query(
      `UPDATE subkit.workflows_schedules
          SET admission_hold = NULL, last_enqueued_at = clock_timestamp()
        WHERE tenant_id = $1 AND workflow_id = $2 AND execution_mode = 'prod'
          AND paused = false AND admission_hold IS NOT NULL`,
      [user.tenant_id, workflowId],
    );
    return id;
  } finally {
    await client.end();
  }
}

export async function scheduledRunAuthorities(workflowId: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: containerDatabaseUrl() });
  await client.connect();
  try {
    const rows = await client.query<{ execution_authority_id: string | null }>(
      `SELECT execution_authority_id FROM subkit.executions
        WHERE workflow_id = $1 AND request_source = 'scheduler'`,
      [workflowId],
    );
    return rows.rows.flatMap((row) =>
      row.execution_authority_id ? [row.execution_authority_id] : [],
    );
  } finally {
    await client.end();
  }
}
