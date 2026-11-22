#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCockpitDemoBranding } from "./lib/cockpit-demo-branding.ts";
import { cockpitDemoCheckoutFingerprint } from "./lib/cockpit-demo-fingerprint.ts";
import {
  assertCockpitDemoActionMarker,
  assertCockpitDemoMarker,
  cockpitDemoEngineNeedsRecreate,
  cockpitDemoImage,
  cockpitDemoMarker,
  readCockpitDemoMarker,
  resolveCockpitDemoInstance,
} from "./lib/cockpit-demo-instance.ts";
import {
  type CockpitDemoAuthorityPreview,
  cockpitDemoId,
  cockpitDemoManifest,
  cockpitDemoOwnerEmail,
  cockpitDemoOwnerSql,
  cockpitDemoSetupTenantName,
  cockpitDemoTenantSlug,
  createCockpitDemoApprovalSql,
  createCockpitDemoCatalogRepairSql,
  createCockpitDemoSeedSql,
  demoApprovedWorkflow,
  demoFiles,
  demoHistory,
  demoMonthlyBudgetTokens,
  demoTemplateConnectors,
} from "./lib/cockpit-demo-seed.ts";
import { dockerAvailableKiB, dockerStorageProblem } from "./lib/cockpit-demo-storage.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTANCE = resolveCockpitDemoInstance(process.env, ROOT);
const IMAGE = cockpitDemoImage(INSTANCE);
const PROJECT = INSTANCE.project;
const PORT = String(INSTANCE.apiPort);
const DB_PORT = String(INSTANCE.dbPort);
const BASE = INSTANCE.baseUrl;
const STATE_DIR = INSTANCE.stateDir;
const MARKER_FILE = join(STATE_DIR, "instance.json");
const KEY_FILE = join(STATE_DIR, "api-key.txt");
const STATE_FILE = join(STATE_DIR, "state.json");
const BUILD_FILE = join(STATE_DIR, "build.json");
const COMPOSE = [
  "compose",
  "--env-file",
  "/dev/null",
  "-p",
  PROJECT,
  "-f",
  "docker/docker-compose.test.yml",
  "-f",
  "docker/docker-compose.demo.yml",
];
const env = {
  ...process.env,
  SUBKIT_DB_PORT: DB_PORT,
  SUBKIT_TEST_IMAGE: IMAGE,
  SUBKIT_TEST_PORT: PORT,
  SUBKIT_DEMO_STATE_DIR: STATE_DIR,
  SUBKIT_DEMO_URL: BASE,
  ...(INSTANCE.id ? { SUBKIT_DEMO_INSTANCE: INSTANCE.id } : {}),
};
let key = "";
const CATALOG_RETRY_ATTEMPTS = 8;

type DemoState = {
  tenantId?: string;
  filesReady?: boolean;
  uploadedFiles?: Record<string, string>;
  platformSeedPending?: boolean;
  providers?: string;
  brandingDigest?: string;
  historyReady?: boolean;
};

function run(args: string[], capture = false, input?: string) {
  return spawnSync("docker", [...COMPOSE, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : ["ignore", "inherit", "inherit"],
    ...(input !== undefined ? { input } : {}),
  });
}

function fail(message: string): never {
  throw new Error(message);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function save(file: string, value: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function sql(statement: string): string {
  const result = run(
    [
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
    ],
    true,
    statement,
  );
  if (result.status !== 0) fail(`Demo database operation failed: ${result.stderr.slice(-1800)}`);
  return result.stdout.trim();
}

export function retryableDemoRequest(status: number, code: string): boolean {
  return status === 409 && code === "catalog_vocabulary_changed";
}

async function seedDemoApproval(identities: { tenantId: string; adminUserId: string }) {
  const workflowId = cockpitDemoId(identities.tenantId, demoApprovedWorkflow.key);
  const versionId = cockpitDemoId(identities.tenantId, demoApprovedWorkflow.versionKey);
  const present = sql(
    `SELECT count(*) FROM workflow_versions WHERE tenant_id='${identities.tenantId}' AND workflow_id='${workflowId}' AND id='${versionId}';`,
  );
  if (present.trim() !== "1") return;
  const preview = (await api(
    `/v1/workflows/${workflowId}/versions/${versionId}/authority-preview?environment=prod`,
  )) as CockpitDemoAuthorityPreview;
  sql(createCockpitDemoApprovalSql(identities.tenantId, identities.adminUserId, preview));
}

async function api(path: string, method = "GET", body?: unknown) {
  for (let attempt = 0; attempt < CATALOG_RETRY_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${BASE}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.ok) return response.status === 204 ? null : response.json();
    let code = "request_failed";
    try {
      code = (await response.json()).code ?? code;
    } catch {}
    if (retryableDemoRequest(response.status, code) && attempt + 1 < CATALOG_RETRY_ATTEMPTS) {
      await Bun.sleep(Math.min(250 * 2 ** attempt, 2_000));
      continue;
    }
    fail(`${method} ${path.split("?")[0]}: HTTP ${response.status} (${code})`);
  }
  fail(`${method} ${path.split("?")[0]}: catalog vocabulary retry exhausted`);
}

async function keyWorks(): Promise<boolean> {
  if (!key) return false;
  try {
    await api("/v1/workflows");
    return true;
  } catch {
    return false;
  }
}

function sourceFingerprint(): string {
  return cockpitDemoCheckoutFingerprint(ROOT);
}

function imageId(): string {
  const image = spawnSync("docker", ["image", "inspect", IMAGE, "--format", "{{.Id}}"], {
    encoding: "utf8",
  });
  return image.status === 0 ? image.stdout.trim() : "";
}

function engineContainerImage(): string {
  const container = run(["ps", "-q", "engine"], true);
  const id = container.status === 0 ? container.stdout.trim() : "";
  if (!id) return "";
  const image = spawnSync("docker", ["inspect", "--format", "{{.Image}}", id], {
    encoding: "utf8",
  });
  return image.status === 0 ? image.stdout.trim() : "";
}

function checkDockerStorage(building: boolean): void {
  let checked = run(["exec", "-T", "postgres", "df", "-Pk", "/var/lib/postgresql"], true);
  if (checked.status !== 0) {
    const configured = run(["config", "--format", "json"], true);
    if (configured.status !== 0)
      fail("Cannot resolve the isolated Docker configuration for storage check");
    const configuration = JSON.parse(configured.stdout) as {
      services: Record<string, { image?: string }>;
    };
    const postgres = configuration.services.postgres?.image;
    if (!postgres) fail("The pinned PostgreSQL image is missing from the demo configuration");
    const candidates = [IMAGE, postgres, configuration.services["demo-api"]?.image].filter(
      (image): image is string => Boolean(image),
    );
    let probeImage = candidates.find(
      (image) => spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0,
    );
    if (!probeImage) {
      if (run(["pull", "postgres"]).status !== 0)
        fail(
          "Cannot prepare the required PostgreSQL image for Docker storage check; inspect Docker Desktop storage and daemon status",
        );
      probeImage = postgres;
    }
    checked = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--read-only",
        "--entrypoint",
        "df",
        probeImage,
        "-Pk",
        "/",
      ],
      { cwd: ROOT, env, encoding: "utf8", stdio: "pipe" },
    );
  }
  if (checked.status !== 0)
    fail(
      "Cannot measure Docker filesystem storage; check Docker Desktop and its disk image limit before starting the demo",
    );
  const problem = dockerStorageProblem(dockerAvailableKiB(checked.stdout), building);
  if (problem) fail(problem);
}

async function configureProviders(
  tenantId: string,
  state: DemoState,
  mock: boolean,
): Promise<void> {
  const readKey = (name: string) =>
    existsSync(join(ROOT, name)) ? readFileSync(join(ROOT, name), "utf8").trim() : "";
  const anthropic = mock ? "" : readKey("claude-key.txt");
  const openai = mock ? "" : readKey("openai-key.txt");
  if (!mock && !anthropic && !openai)
    fail(
      "Add claude-key.txt or openai-key.txt for real AI, or explicitly use --mock for offline testing",
    );
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        anthropic,
        openai,
        mock,
        primary: "openai",
        fallback: "anthropic-elevation",
      }),
    )
    .digest("hex");
  if (state.providers === digest) return;
  const put = (path: string, value: unknown) =>
    api(`/v1/settings/${path}?tenant=${tenantId}`, "PUT", { value });
  if (anthropic) {
    await put("llm.providers.anthropic.api_key", anthropic);
    await put("llm.providers.anthropic.model", "claude-sonnet-4-6");
  }
  if (openai) {
    await put("llm.providers.openai.api_key", openai);
    await put("llm.providers.openai.model", "gpt-5.6-sol");
  }
  await put("llm.provider", openai ? "openai" : anthropic ? "anthropic" : "mock");
  await put("llm.api_key", openai || anthropic || "mock");
  await put("llm.model", openai ? "gpt-5.6-sol" : anthropic ? "claude-sonnet-4-6" : "");
  await put("llm.fallback_provider", anthropic && openai ? "anthropic" : openai ? "openai" : null);
  await put(
    "llm.fallback_model",
    anthropic && openai ? "claude-sonnet-4-6" : openai ? "gpt-5.6-sol" : "",
  );
  state.providers = digest;
  save(STATE_FILE, state);
}

async function verifyProviderConfiguration(tenantId: string): Promise<void> {
  const setting = async (path: string) =>
    (await api(`/v1/settings/${path}?tenant=${tenantId}`)).value;
  const primary = await setting("llm.provider");
  const fallback = await setting("llm.fallback_provider");
  for (const provider of new Set([primary, fallback])) {
    if (!provider || provider === "mock") continue;
    if (provider !== "anthropic" && provider !== "openai") continue;
    const credential = await setting(`llm.providers.${provider}.api_key`);
    if (typeof credential !== "string" || credential.length === 0)
      fail(`Local ${provider} credentials are missing; configure the provider in Cockpit`);
    const selectedModel = await setting(provider === primary ? "llm.model" : "llm.fallback_model");
    const providerModel = await setting(`llm.providers.${provider}.model`);
    if (!selectedModel && !providerModel)
      fail(`Local ${provider} model is missing; configure the model in Cockpit`);
  }
}

async function finishInitialPlatformSeed(state: DemoState): Promise<void> {
  if (!state.platformSeedPending) return;
  const provider = await api(`/v1/settings/llm.provider?tenant=${state.tenantId}`);
  if (provider.value !== "mock")
    fail(
      "Initial platform seeding requires the initial mock provider; reset the demo to rebuild its baseline",
    );
  const since = new Date().toISOString();
  if (run(["restart", "engine"]).status !== 0) fail("Cannot restart initial demo seed");
  if (run(["up", "-d", "--wait", "engine"]).status !== 0)
    fail("Initial demo restart did not become healthy");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const logs = run(["logs", "--no-log-prefix", "--since", since, "engine"], true);
    if (logs.status !== 0) fail("Cannot read initial platform seed status");
    const completed = new Set<string>();
    for (const line of logs.stdout.split("\n")) {
      let entry: { module?: string; action?: string };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.module !== "knowledge.seed" && entry.module !== "skills.seed") continue;
      if (entry.action === "seed.failed") fail(`Initial ${entry.module} failed`);
      if (entry.action === "seed.applied" || entry.action === "seed.empty")
        completed.add(entry.module);
    }
    if (completed.size === 2) {
      state.platformSeedPending = false;
      save(STATE_FILE, state);
      return;
    }
    await Bun.sleep(500);
  }
  fail("Initial platform seed did not finish before the timeout");
}

async function seedDemoHistory(tenantId: string, state: DemoState): Promise<void> {
  if (state.historyReady) return;
  const own = (name: string) => cockpitDemoId(tenantId, name);
  for (const connector of demoTemplateConnectors)
    if (connector.token)
      await api(`/v1/connectors/${own(connector.key)}/credentials`, "POST", {
        mode: "bearer",
        token: connector.token,
      });
  const revoked = demoTemplateConnectors
    .filter((connector) => connector.needsReauth)
    .map((connector) => `'${own(connector.key)}'`);
  if (revoked.length > 0)
    sql(
      `UPDATE connectors SET needs_reauth=true, health_state='needs_reauth', auth_failed_at=now(), auth_failed_reason='Access token was revoked by the provider' WHERE tenant_id='${tenantId}' AND id IN (${revoked.join(",")});`,
    );
  const skillId = own(demoHistory.skill.key);
  for (const body of demoHistory.skill.bodies) {
    const skill = await api(`/v1/skills/${skillId}`);
    await api(`/v1/skills/${skillId}`, "PATCH", { expected_version: skill.version, body });
  }
  const fileId = state.uploadedFiles?.[demoHistory.file.filename];
  if (!fileId) fail("Demo file for the replaced version is missing");
  await api(`/v1/files/${fileId}/replace`, "POST", {
    filename: demoHistory.file.filename,
    content_type: "text/markdown",
    content_base64: Buffer.from(demoHistory.file.content).toString("base64"),
  });
  const month = new Date();
  const bucket = month.getUTCFullYear() * 100 + month.getUTCMonth() + 1;
  const tokens = JSON.parse(
    sql(
      `SELECT json_build_object('used',coalesce(sum(total_tokens) FILTER (WHERE month_bucket=${bucket}),0),'seven',coalesce(sum(total_tokens) FILTER (WHERE created_at>now()-interval '7 days'),0)) FROM llm_usage WHERE tenant_id='${tenantId}';`,
    ),
  ) as { used: number; seven: number };
  const budget = demoMonthlyBudgetTokens({
    usedTokens: Number(tokens.used),
    lastSevenDaysTokens: Number(tokens.seven),
    now: new Date(),
  });
  if (budget !== null)
    await api(`/v1/settings/tokens.monthly_budget?tenant=${tenantId}`, "PUT", { value: budget });
  state.historyReady = true;
  save(STATE_FILE, state);
}

async function verifyLogin(): Promise<void> {
  const choice = await (await fetch(`${BASE}/v1/identity/login/start`)).text();
  const href = choice.match(/href="([^"]*provider=api-key[^"]*)"/)?.[1];
  if (!href) fail("The local API-key login option is missing");
  const formUrl = new URL(href.replaceAll("&amp;", "&"), BASE);
  if (formUrl.origin !== BASE) fail("Local login unexpectedly points outside the demo");
  const html = await (await fetch(formUrl)).text();
  const state = html.match(/name="login_state" value="([^"]+)"/)?.[1];
  if (!state) fail("The local login state is missing");
  const login = await fetch(`${BASE}/v1/identity/login/start`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ provider: "api-key", login_state: state, api_key: key }),
  });
  if (login.status !== 302) fail(`Local browser login failed: HTTP ${login.status}`);
  const cookie = login.headers
    .getSetCookie()
    .map((part) => part.split(";", 1)[0])
    .join("; ");
  const session = await fetch(`${BASE}/v1/cockpit/bootstrap`, { headers: { cookie } });
  if (!session.ok) fail(`Local browser session failed: HTTP ${session.status}`);
  await fetch(`${BASE}/v1/identity/logout`, { method: "POST", headers: { cookie } });
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  for (const arg of args)
    if (
      !["--stop", "--reset", "--restart", "--rebuild", "--mock", "--status", "--key"].includes(arg)
    )
      fail(`Unknown option: ${arg}`);
  const marker = readCockpitDemoMarker(INSTANCE);
  if (marker) assertCockpitDemoMarker(marker, INSTANCE);
  assertCockpitDemoActionMarker(args, marker, INSTANCE);
  if (existsSync(STATE_DIR)) chmodSync(STATE_DIR, 0o700);
  if (existsSync(KEY_FILE)) chmodSync(KEY_FILE, 0o600);
  if (args.has("--key")) {
    process.stdout.write(readFileSync(KEY_FILE, "utf8"));
    return;
  }
  if (args.has("--stop")) {
    if (run(["down"]).status !== 0) fail("Could not stop the isolated demo");
    process.stdout.write("Demo stopped; named volumes and login key preserved.\n");
    return;
  }
  if (args.has("--status")) {
    if (run(["ps"]).status !== 0) fail("Cannot read local demo status");
    key = readFileSync(KEY_FILE, "utf8").trim();
    await api("/ready");
    await api("/v1/workflows");
    process.stdout.write(`Ready: http://localhost:${PORT}/cockpit\n`);
    return;
  }
  if (args.has("--reset")) {
    process.stdout.write(`Resetting only the ${PROJECT} containers and volumes.\n`);
    if (run(["down", "--volumes", "--remove-orphans"]).status !== 0) fail("Demo reset failed");
    for (const name of [KEY_FILE, STATE_FILE, join(STATE_DIR, "receipt.json")])
      rmSync(name, { force: true });
  } else if (args.has("--restart") && run(["stop"]).status !== 0) fail("Demo stop failed");

  const fingerprint = sourceFingerprint();
  const previousBuild = readJson<{ source: string; image: string }>(BUILD_FILE);
  const id = imageId();
  const rebuild =
    args.has("--rebuild") ||
    !id ||
    previousBuild?.source !== fingerprint ||
    previousBuild.image !== id;
  checkDockerStorage(rebuild);
  process.stdout.write(
    rebuild ? "Building current local sources.\n" : "Reusing the current local image.\n",
  );
  if (rebuild) {
    if (run(["build", "engine"]).status !== 0) fail("The local demo image build failed");
    checkDockerStorage(false);
  }
  if (run(["up", "-d", "--wait", "--no-build"]).status !== 0)
    fail("The isolated demo stack did not become healthy");
  if (cockpitDemoEngineNeedsRecreate(engineContainerImage(), imageId())) {
    if (
      run(["up", "-d", "--wait", "--no-build", "--force-recreate", "--no-deps", "engine"])
        .status !== 0
    )
      fail("The demo engine on the rebuilt image did not become healthy");
    if (cockpitDemoEngineNeedsRecreate(engineContainerImage(), imageId()))
      fail("The demo engine still runs an older image after it was recreated");
  }
  checkDockerStorage(false);
  const currentImage = imageId();
  save(BUILD_FILE, { source: fingerprint, image: currentImage });
  save(MARKER_FILE, cockpitDemoMarker(INSTANCE, currentImage, fingerprint));

  let freshSetup = false;
  key = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "";
  if (!(await keyWorks())) {
    const setup = await fetch(`${BASE}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "b".repeat(64),
        admin_email: cockpitDemoOwnerEmail,
        tenant_name: cockpitDemoSetupTenantName,
        llm_provider: "mock",
        llm_api_key: "mock",
      }),
    });
    if (setup.status !== 200 && setup.status !== 410)
      fail(`Demo bootstrap failed: HTTP ${setup.status}`);
    freshSetup = setup.status === 200;
    const issued = run(
      ["exec", "-T", "engine", "engine", "--issue-admin-key", "--tenant", cockpitDemoTenantSlug],
      true,
    );
    if (issued.status !== 0) fail("Could not issue the local user-owned API key");
    const match = `${issued.stdout}\n${issued.stderr}`.match(/key:\s+(wf_live_[A-Za-z0-9_-]+)/);
    if (!match?.[1]) fail("The local admin API key was missing from the issuer result");
    key = match[1];
    writeFileSync(KEY_FILE, `${key}\n`, { mode: 0o600 });
    chmodSync(KEY_FILE, 0o600);
  }
  const identities = JSON.parse(
    sql(
      `SELECT json_build_object('tenantId',t.id,'adminUserId',u.id) FROM tenants t JOIN users u ON u.tenant_id=t.id ${cockpitDemoOwnerSql} LIMIT 1;`,
    ),
  ) as { tenantId: string; adminUserId: string };
  let state = readJson<DemoState>(STATE_FILE) ?? {};
  if (state.tenantId !== identities.tenantId) state = { tenantId: identities.tenantId };
  if (freshSetup) {
    state.platformSeedPending = true;
    save(STATE_FILE, state);
  }
  sql(createCockpitDemoSeedSql(identities.tenantId, identities.adminUserId));
  await seedDemoApproval(identities);
  if (!state.filesReady) {
    state.uploadedFiles ??= {};
    for (const file of demoFiles) {
      const uploaded = state.uploadedFiles[file.filename]
        ? { id: state.uploadedFiles[file.filename] }
        : await api("/v1/files/inline", "POST", {
            filename: file.filename,
            content_type: file.contentType,
            content_base64: Buffer.from(file.content).toString("base64"),
          });
      state.uploadedFiles[file.filename] = uploaded.id;
      save(STATE_FILE, state);
      await api(`/v1/files/${uploaded.id}/links`, "POST", {
        resource_type: "conversation",
        resource_id: cockpitDemoId(identities.tenantId, "conversation-0"),
        role: "attachment",
      });
      await api(`/v1/files/${uploaded.id}`, "PATCH", {
        category: file.category,
        description: file.description,
      });
      const content = await fetch(`${BASE}/v1/files/${uploaded.id}/content`, {
        headers: { authorization: `Bearer ${key}` },
      });
      if (!content.ok || (await content.text()) !== file.content)
        fail(`Demo file download mismatch: ${file.filename}`);
    }
    await api("/v1/settings/egress.mode", "PUT", { value: "permissive" });
    state.filesReady = true;
    save(STATE_FILE, state);
  }
  await finishInitialPlatformSeed(state);
  sql(createCockpitDemoCatalogRepairSql(identities.tenantId));
  await seedDemoHistory(identities.tenantId, state);
  await api("/v1/settings/observability.deployment_environment", "PUT", { value: "development" });
  const brandingDigest = await applyCockpitDemoBranding(api, state.brandingDigest);
  if (brandingDigest !== state.brandingDigest) {
    state.brandingDigest = brandingDigest;
    save(STATE_FILE, state);
  }
  await configureProviders(identities.tenantId, state, args.has("--mock"));
  await verifyProviderConfiguration(identities.tenantId);
  await verifyLogin();
  const counts = JSON.parse(
    sql(
      `SELECT json_build_object(${["connectors", "workflows", "executions", "conversations", "knowledge_sources", "skills", "files", "users"].map((table) => `'${table}',(SELECT count(*) FROM ${table} WHERE tenant_id='${identities.tenantId}')`).join(",")});`,
    ),
  );
  const provider = await api(`/v1/settings/llm.provider?tenant=${identities.tenantId}`);
  const model = await api(`/v1/settings/llm.model?tenant=${identities.tenantId}`);
  save(join(STATE_DIR, "receipt.json"), {
    checkedAt: new Date().toISOString(),
    source: fingerprint,
    image: imageId(),
    counts,
    dataset: cockpitDemoManifest,
    login: "passed",
    provider: provider.value,
    model: model.value,
    liveModelCall: "manual",
    visualReview: "manual",
  });
  process.stdout.write(
    `\nCockpit: http://localhost:${PORT}/cockpit\nLocal admin API key: ${key}\nKey file: ${KEY_FILE}\nProvider: ${provider.value} / ${model.value}\nDemo records: ${JSON.stringify(counts)}\nStart preserves edits; demo reset restores the synthetic dataset and issues a new key.\n`,
  );
}

if (import.meta.main)
  await main().catch((error) => {
    process.stderr.write(
      `cockpit-demo: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
