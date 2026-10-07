import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import pc from "picocolors";
import { z } from "zod";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../audit/types.ts";
import { setConfigKey } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { engineSettings, tenants } from "../db/schema/identity.ts";
import { seedTenantBootstrap, type TenantBootstrapPayload } from "../db/seed.ts";
import { type LlmAccessProbe, probeLlmAccess } from "../llm/core/access-probe.ts";
import { logger } from "../logging/logger.ts";
import type { SeededRoleIds } from "../rbac/seed.ts";
import {
  activateRuntimeRevision,
  createSecretVersion,
  getRuntimeConfigState,
  RuntimeConfigNotFoundError,
  saveRuntimeConfigPatch,
} from "../runtime-config/service.ts";
import { now } from "../utils/clock.ts";

export const BOOTSTRAP_COMPLETED_KEY = "bootstrap.completed";
export const BOOTSTRAP_TOKEN_KEY = "bootstrap.token";

export const BOOTSTRAP_TOKEN_TTL_MS = 15 * 60 * 1000;

export const BOOTSTRAP_MAX_ATTEMPTS = 5;
export const BOOTSTRAP_WINDOW_MS = 15 * 60 * 1000;

export const BOOTSTRAP_LLM_PROVIDERS = [
  "mock",
  "anthropic",
  "openai",
  "gemini",
  "azure",
  "bedrock",
  "vertex",
] as const;

export type BootstrapLlmProvider = (typeof BOOTSTRAP_LLM_PROVIDERS)[number];

export const BootstrapSetupPayloadSchema = z.object({
  admin_email: z.string().email().min(3).max(254),
  tenant_name: z.string().min(1).max(120),
  llm_provider: z.enum(BOOTSTRAP_LLM_PROVIDERS),
  llm_api_key: z.string().min(1).max(4096),
  llm_model: z.string().trim().min(1).max(200).optional(),
});

export type BootstrapSetupPayload = z.infer<typeof BootstrapSetupPayloadSchema>;

interface TokenEnvelope {
  token_sha256: string;
  expires_at_ms: number;
}

interface RateLimitEntry {
  count: number;
  window_started_at: number;
}

const ipAttempts = new Map<string, RateLimitEntry>();

export function _resetRateLimitForTests(): void {
  ipAttempts.clear();
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function readSetting<T>(db: Db, key: string): Promise<T | undefined> {
  const rows = await db
    .select({ value: engineSettings.value })
    .from(engineSettings)
    .where(eq(engineSettings.key, key))
    .limit(1);
  return rows[0]?.value as T | undefined;
}

async function writeSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(engineSettings)
    .values({ key, value, updated_by: null })
    .onConflictDoUpdate({
      target: engineSettings.key,
      set: { value, updated_by: null, updated_at: new Date(now()) },
    });
}

async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.delete(engineSettings).where(eq(engineSettings.key, key));
}

async function tenantsCount(db: Db): Promise<number> {
  const rows = await db.select({ id: tenants.id }).from(tenants).limit(1);
  return rows.length;
}

export async function isBootstrapPending(db: Db): Promise<boolean> {
  const sentinel = await readSetting<boolean>(db, BOOTSTRAP_COMPLETED_KEY);
  if (sentinel === true) return false;
  const count = await tenantsCount(db);
  return count === 0;
}

export async function isBootstrapTokenExpired(db: Db): Promise<boolean> {
  if (!(await isBootstrapPending(db))) return false;
  const envelope = await readSetting<TokenEnvelope>(db, BOOTSTRAP_TOKEN_KEY);
  if (!envelope) return false;
  return envelope.expires_at_ms < now();
}

async function mintToken(db: Db): Promise<{ plaintext: string; expires_at: Date }> {
  const plaintext = process.env.SUBKIT_BOOTSTRAP_KEY ?? randomBytes(32).toString("hex");
  if (plaintext.length < 64 || plaintext.length > 128) {
    throw new Error("SUBKIT_BOOTSTRAP_KEY must contain 64..128 characters");
  }
  const envelope: TokenEnvelope = {
    token_sha256: sha256Hex(plaintext),
    expires_at_ms: now() + BOOTSTRAP_TOKEN_TTL_MS,
  };
  await writeSetting(db, BOOTSTRAP_TOKEN_KEY, envelope);
  return { plaintext, expires_at: new Date(envelope.expires_at_ms) };
}

export function buildBootstrapBanner(plaintextToken: string, expiresAt: Date): string {
  const banner = pc.bgYellow(pc.black(" SUBKIT FIRST-RUN BOOTSTRAP "));
  const headline = pc.bold("This engine has no tenants yet. Complete first-run setup:");
  const cmd = pc.cyan(`sk init --token ${plaintextToken}`);
  const ttl = pc.dim(`Token expires at ${expiresAt.toISOString()} (15 minutes).`);
  const note = pc.dim("This banner only prints once per fresh install. Copy the command now.");
  return `\n${banner}\n${headline}\n\n  ${cmd}\n\n${ttl}\n${note}\n\n`;
}

export interface BootstrapRunResult {
  status: "minted" | "already_completed";
  plaintext_token?: string;
  expires_at?: Date;
}

export interface BootstrapRunDeps {
  stdout?: { write: (chunk: string) => unknown };
}

export async function run(db: Db, deps: BootstrapRunDeps = {}): Promise<BootstrapRunResult> {
  if (!(await isBootstrapPending(db))) {
    logger.info({
      module: "onboarding.bootstrap",
      action: "bootstrap.skipped",
      msg: "bootstrap not pending — sentinel set or tenants present",
    });
    return { status: "already_completed" };
  }

  const { plaintext, expires_at } = await mintToken(db);
  const out = deps.stdout ?? process.stdout;
  out.write(buildBootstrapBanner(plaintext, expires_at));

  logger.warn({
    module: "onboarding.bootstrap",
    action: "bootstrap.token_minted",
    msg: "first-run bootstrap token minted; awaiting POST /v1/setup",
    expires_at: expires_at.toISOString(),
    ttl_ms: BOOTSTRAP_TOKEN_TTL_MS,
  });

  return { status: "minted", plaintext_token: plaintext, expires_at };
}

export type ConsumeFailureCode =
  | "rate_limited"
  | "gone"
  | "invalid_token"
  | "token_expired"
  | "validation_failed"
  | "llm_unreachable";

export type ConsumeOutcome =
  | {
      status: "ok";
      tenant_id: string;
      user_id: string;
      api_key_plaintext: string;
      api_key_prefix: string;
    }
  | {
      status: "failed";
      code: ConsumeFailureCode;
      message: string;
      hint?: string;
    };

export interface ConsumeOptions {
  ip?: string;
  user_agent?: string | null;
  stdout?: { write: (chunk: string) => unknown };
  probe?: LlmAccessProbe;
}

export const LLM_UNREACHABLE_HINT =
  "nothing was saved — no tenant, no key; fix the key or the provider and run `sk init` again with the same token";

export async function consume(
  db: Db,
  rbacIds: SeededRoleIds,
  rawPayload: unknown,
  opts: ConsumeOptions & { token: string },
): Promise<ConsumeOutcome> {
  const ip = opts.ip ?? "unknown";
  if (!checkRateLimit(ip)) {
    await emitFailure(db, "rate_limited", "rate limit exceeded for this IP", opts);
    return {
      status: "failed",
      code: "rate_limited",
      message: "too many bootstrap attempts from this IP — wait 15 minutes",
    };
  }

  const sentinel = await readSetting<boolean>(db, BOOTSTRAP_COMPLETED_KEY);
  if (sentinel === true || (await tenantsCount(db)) > 0) {
    await emitFailure(db, "gone", "bootstrap already completed", opts);
    return {
      status: "failed",
      code: "gone",
      message: "bootstrap already completed",
    };
  }

  const envelope = await readSetting<TokenEnvelope>(db, BOOTSTRAP_TOKEN_KEY);
  if (!envelope) {
    await emitFailure(db, "invalid_token", "no bootstrap token on file", opts);
    return {
      status: "failed",
      code: "invalid_token",
      message: "no active bootstrap token",
    };
  }
  if (envelope.expires_at_ms < now()) {
    const reminted = await mintToken(db);
    (opts.stdout ?? process.stdout).write(
      buildBootstrapBanner(reminted.plaintext, reminted.expires_at),
    );
    logger.warn({
      module: "onboarding.bootstrap",
      action: "bootstrap.token_reminted",
      msg: "expired bootstrap token redeemed; fresh token minted and banner reprinted",
      expires_at: reminted.expires_at.toISOString(),
    });
    await emitFailure(db, "token_expired", "bootstrap token expired — fresh token minted", opts);
    return {
      status: "failed",
      code: "token_expired",
      message: "bootstrap token expired",
      hint: "a fresh token was just printed to the engine logs — copy the new `sk init --token <token>` command from there and re-run it",
    };
  }
  if (!constantTimeEquals(sha256Hex(opts.token), envelope.token_sha256)) {
    await emitFailure(db, "invalid_token", "token mismatch", opts);
    return {
      status: "failed",
      code: "invalid_token",
      message: "invalid bootstrap token",
    };
  }

  const parsed = BootstrapSetupPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    await emitFailure(db, "validation_failed", "payload failed schema validation", opts, {
      issues: parsed.error.issues.map((i) => ({
        path: i.path,
        message: i.message,
      })),
    });
    return {
      status: "failed",
      code: "validation_failed",
      message: "setup payload failed validation",
    };
  }
  const payload = parsed.data;

  const access = await (opts.probe ?? probeLlmAccess)({
    provider: payload.llm_provider,
    api_key: payload.llm_api_key,
    ...(payload.llm_model ? { model: payload.llm_model } : {}),
  });
  if (!access.ok) {
    await emitFailure(db, "llm_unreachable", access.reason, opts, {
      llm_provider: payload.llm_provider,
      model: access.model,
    });
    return {
      status: "failed",
      code: "llm_unreachable",
      message: `the LLM access check failed: ${access.reason}`,
      hint: LLM_UNREACHABLE_HINT,
    };
  }

  const result = await seedTenantBootstrap(db, rbacIds, {
    admin_email: payload.admin_email,
    tenant_name: payload.tenant_name,
    tenant_slug: deriveTenantSlug(payload.tenant_name),
    create_metrics_key: false,
  });

  if (result.api_key === null) {
    await emitFailure(db, "validation_failed", "tenant bootstrap returned no api key", opts);
    return {
      status: "failed",
      code: "validation_failed",
      message: "tenant bootstrap failed",
    };
  }
  const completedResult = { ...result, api_key: result.api_key };

  try {
    const state = await getRuntimeConfigState(db);
    const secret = await createSecretVersion(db, {
      name: `tenants.${result.tenant_id}.settings.llm.api_key`,
      value: payload.llm_api_key,
      created_by: result.user_id,
    });
    const saved = await saveRuntimeConfigPatch(db, {
      expected_revision: state.saved_revision,
      changes: {
        "llm.provider": payload.llm_provider,
        "llm.api_key": secret.reference,
        ...(payload.llm_model ? { "llm.model": payload.llm_model } : {}),
      },
      scope: "tenant",
      tenant_id: result.tenant_id,
      created_by: result.user_id,
    });
    const activated = await activateRuntimeRevision(db, saved.saved_revision);
    if (activated.activation_status !== "active") {
      throw new Error(`bootstrap config activation failed: ${activated.activation_status}`);
    }
    await auditAwait(
      {
        tenant_id: result.tenant_id,
        actor_type: "user",
        actor_id: result.user_id,
        action: AuditAction.SECRET_VERSION_CREATED,
        resource_type: "runtime_secret",
        resource_id: secret.reference,
        metadata: {
          name: secret.name,
          version: secret.version,
          source: "bootstrap",
        },
      },
      db,
    );
  } catch (err) {
    if (err instanceof RuntimeConfigNotFoundError) {
      try {
        await setConfigKey(["llm", "provider"], payload.llm_provider, {
          force: true,
        });
        await setConfigKey(["llm", "api_key"], payload.llm_api_key, {
          force: true,
        });
        if (payload.llm_model) {
          await setConfigKey(["llm", "model"], payload.llm_model, { force: true });
        }
      } catch (fallbackError) {
        logger.warn({
          module: "onboarding.bootstrap",
          action: "setup.config_persist_skipped",
          msg: "runtime config is not initialized in this standalone path; tenant settings remain canonical",
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
      }
      return finishBootstrap(db, completedResult, payload, opts);
    }
    logger.warn({
      module: "onboarding.bootstrap",
      action: "setup.config_persist_failed",
      msg: "runtime configuration revision failed; tenant bootstrap remains incomplete",
      error: err instanceof Error ? err.message : String(err),
    });
    await emitFailure(db, "validation_failed", "runtime configuration activation failed", opts);
    return {
      status: "failed",
      code: "validation_failed",
      message: "runtime configuration activation failed",
    };
  }

  return finishBootstrap(db, completedResult, payload, opts);
}

async function finishBootstrap(
  db: Db,
  result: Awaited<ReturnType<typeof seedTenantBootstrap>> & {
    api_key: NonNullable<Awaited<ReturnType<typeof seedTenantBootstrap>>["api_key"]>;
  },
  payload: BootstrapSetupPayload,
  opts: ConsumeOptions,
): Promise<ConsumeOutcome> {
  await writeSetting(db, BOOTSTRAP_COMPLETED_KEY, true);
  await deleteSetting(db, BOOTSTRAP_TOKEN_KEY);
  try {
    const { seedOnboardingDemo } = await import("./demo-seed.ts");
    const seeded = await seedOnboardingDemo(
      { tenant_id: result.tenant_id, actor_id: result.user_id },
      db,
    );
    logger.info({
      module: "onboarding.bootstrap",
      action: "setup.demo_seeded",
      msg: "seeded starter workflows for the new tenant",
      tenant_id: result.tenant_id,
      created: seeded.created,
      skipped: seeded.skipped,
    });
  } catch (err) {
    logger.warn({
      module: "onboarding.bootstrap",
      action: "setup.demo_seed_failed",
      msg: "starter workflows could not be seeded; the tenant is usable but starts empty",
      tenant_id: result.tenant_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await auditAwait(
    {
      tenant_id: SYSTEM_TENANT_ID,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.SETUP_COMPLETED,
      resource_type: "bootstrap",
      resource_id: result.tenant_id,
      result: "success",
      ip: opts.ip ?? null,
      user_agent: opts.user_agent ?? null,
      metadata: {
        tenant_id: result.tenant_id,
        admin_email: payload.admin_email,
        llm_provider: payload.llm_provider,
      },
    },
    db,
  );

  logger.info({
    module: "onboarding.bootstrap",
    action: "bootstrap.completed",
    msg: "first-run bootstrap completed",
    tenant_id: result.tenant_id,
    user_id: result.user_id,
  });

  return {
    status: "ok",
    tenant_id: result.tenant_id,
    user_id: result.user_id,
    api_key_plaintext: result.api_key.plaintext,
    api_key_prefix: result.api_key.prefix,
  };
}

function checkRateLimit(ip: string): boolean {
  const checkedAt = now();
  const entry = ipAttempts.get(ip);
  if (!entry || checkedAt - entry.window_started_at > BOOTSTRAP_WINDOW_MS) {
    ipAttempts.set(ip, { count: 1, window_started_at: checkedAt });
    return true;
  }
  if (entry.count >= BOOTSTRAP_MAX_ATTEMPTS) return false;
  entry.count += 1;
  return true;
}

async function emitFailure(
  db: Db,
  code: ConsumeFailureCode,
  reason: string,
  opts: ConsumeOptions,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await auditAwait(
      {
        tenant_id: SYSTEM_TENANT_ID,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.SETUP_FAILED,
        resource_type: "bootstrap",
        resource_id: null,
        result: "denied",
        reason,
        ip: opts.ip ?? null,
        user_agent: opts.user_agent ?? null,
        metadata: { code, ...extra },
      },
      db,
    );
  } catch (err) {
    logger.warn({
      module: "onboarding.bootstrap",
      action: "bootstrap.audit_failed",
      msg: "failed to write SETUP_FAILED audit row",
      code,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function deriveTenantSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "subkit";
}

export const _internal = {
  readSetting,
  writeSetting,
  deleteSetting,
  tenantsCount,
  mintToken,
  sha256Hex,
};

export type { LlmAccessProbe, TenantBootstrapPayload };
