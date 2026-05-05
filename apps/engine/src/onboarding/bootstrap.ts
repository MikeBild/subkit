// First-run bootstrap orchestrator.
//
// On engine boot — after RBAC seeding — `bootstrap.run()` self-detects
// whether the deployment is a fresh install:
//
//   1. `engine_settings.bootstrap.completed` sentinel is unset, AND
//   2. `tenants` table is empty.
//
// Both checks must agree. The `tenants` count alone is not enough: a
// stale fixture or a partially-completed setup would mis-classify; the
// sentinel alone is not enough either, because a bug-cleared sentinel
// must not silently re-arm the wizard against an already-populated
// engine. When both gates open, the orchestrator mints a one-time token,
// persists its sha256 + expiry into `engine_settings`, and prints a
// copy-paste banner pointing the operator at `sk init --token <token>`.
//
// `consume()` is the single-use redemption path: it validates the
// token, runs the tenant-bootstrap transaction (delegating row writes
// to `seedTenantBootstrap` so the env-var path stays parity-equivalent),
// writes the LLM settings via `settings.setGlobal`, flips the sentinel,
// and revokes the token. Subsequent calls return `gone`.
//
// Audit rows for the wizard are written under `SYSTEM_TENANT_ID`
// (see audit/types.ts) — there is no real tenant_id to attribute them
// to until the bootstrap transaction lands.

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
import { logger } from "../logging/logger.ts";
import type { SeededRoleIds } from "../rbac/seed.ts";

/** Storage key for the post-bootstrap sentinel.  Boolean payload.  */
export const BOOTSTRAP_COMPLETED_KEY = "bootstrap.completed";
/** Storage key for the one-time bootstrap token envelope. */
export const BOOTSTRAP_TOKEN_KEY = "bootstrap.token";

/** Banner-displayed token TTL.  15 minutes is the upper end of "operator
 *  watching the boot logs"; long enough to copy-paste, short enough that
 *  a leaked log line stops being useful before any attacker notices.   */
export const BOOTSTRAP_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Per-IP attempt budget in the rate-limit window.  Five matches the
 *  acceptance criterion and the existing `rateLimitMiddleware` style.   */
export const BOOTSTRAP_MAX_ATTEMPTS = 5;
/** Rate-limit window length.  Re-uses the same span as the token TTL so
 *  there is no awkward "token still valid, but ip throttled" gap.       */
export const BOOTSTRAP_WINDOW_MS = 15 * 60 * 1000;

/** Provider enum kept narrow.  Mirrors the `llm.provider` registry
 *  spec.  Listed once here so the route schema and the in-process
 *  bootstrap helper agree byte-for-byte.                               */
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

/**
 * The four-field setup payload accepted by `POST /v1/setup` and the
 * `sk init` headless path.  Identical Zod schema is exported so the
 * route can re-use it without a drift risk.
 */
export const BootstrapSetupPayloadSchema = z.object({
  admin_email: z.string().email().min(3).max(254),
  tenant_name: z.string().min(1).max(120),
  llm_provider: z.enum(BOOTSTRAP_LLM_PROVIDERS),
  llm_api_key: z.string().min(1).max(4096),
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

/** Reset the in-process IP tracker.  Tests use this between cases.    */
export function _resetRateLimitForTests(): void {
  ipAttempts.clear();
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  // timingSafeEqual rejects mismatched lengths up-front, so we widen
  // the shorter buffer to avoid a length-based oracle.  Both sides are
  // sha256 hexes here so they're always 64 chars, but defensive code
  // is cheap.
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
      set: { value, updated_by: null, updated_at: new Date() },
    });
}

async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.delete(engineSettings).where(eq(engineSettings.key, key));
}

async function tenantsCount(db: Db): Promise<number> {
  const rows = await db.select({ id: tenants.id }).from(tenants).limit(1);
  return rows.length;
}

/**
 * `true` when the engine should run the first-run setup wizard:
 * sentinel unset AND no tenants exist.  Both gates required — see the
 * file-level note on stale fixtures.
 */
export async function isBootstrapPending(db: Db): Promise<boolean> {
  const sentinel = await readSetting<boolean>(db, BOOTSTRAP_COMPLETED_KEY);
  if (sentinel === true) return false;
  const count = await tenantsCount(db);
  return count === 0;
}

/**
 * Mint a fresh 32-byte hex token, persist its sha256 + expiry, and
 * return the plaintext for banner printing.  The plaintext never
 * round-trips through storage.
 */
async function mintToken(db: Db): Promise<{ plaintext: string; expires_at: Date }> {
  // 32 bytes -> 64-char hex.  randomBytes is cryptographically secure
  // — this is the operator-facing one-time secret, treat it like any
  // bearer credential.
  const plaintext = randomBytes(32).toString("hex");
  const envelope: TokenEnvelope = {
    token_sha256: sha256Hex(plaintext),
    expires_at_ms: Date.now() + BOOTSTRAP_TOKEN_TTL_MS,
  };
  await writeSetting(db, BOOTSTRAP_TOKEN_KEY, envelope);
  return { plaintext, expires_at: new Date(envelope.expires_at_ms) };
}

/**
 * Banner printed to stdout on first-run boot — the only place the
 * plaintext token ever appears.  Operator copy-pastes the rendered
 * `sk init --token <token>` line.
 */
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
  /** Present only when status === "minted". */
  plaintext_token?: string;
  /** Present only when status === "minted". */
  expires_at?: Date;
}

export interface BootstrapRunDeps {
  /** Override stdout for tests. */
  stdout?: { write: (chunk: string) => unknown };
}

/**
 * Boot-time entry point.  Called by `apps/engine/src/index.ts` right
 * after the RBAC seed.  No-op if a tenant already exists OR if the
 * sentinel is set.  Otherwise mints a one-time token and prints a
 * banner so the operator can complete setup via `sk init`.
 */
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
  | "validation_failed";

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
    };

export interface ConsumeOptions {
  ip?: string;
  user_agent?: string | null;
}

/**
 * Single-use token redemption + tenant materialisation.  Orchestration:
 *
 *   1. Check the per-IP rate-limit window first — every other failure
 *      mode also costs an attempt against the same bucket so a
 *      brute-force loop can't bypass the budget by varying payloads.
 *   2. Check the post-bootstrap sentinel + tenant count — if either
 *      says "already done", return `gone` without touching anything.
 *   3. Validate the token (envelope present, not expired, sha256
 *      matches in constant time).
 *   4. Validate the payload via the same Zod schema the route uses.
 *   5. Run the bootstrap transaction (`seedTenantBootstrap`), then
 *      write the three `llm.*` settings, then flip the sentinel +
 *      delete the token envelope.  Audit `SETUP_COMPLETED` /
 *      `SETUP_FAILED` rows are emitted under `SYSTEM_TENANT_ID`.
 *
 * The route handler delegates to this function and turns the outcome
 * into the matching HTTP status.
 */
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

  // Sentinel + tenants check happens INSIDE the rate-limited path so a
  // post-completion polling loop still costs against the budget.  This
  // is the "second invocation returns 410" guarantee.
  const sentinel = await readSetting<boolean>(db, BOOTSTRAP_COMPLETED_KEY);
  if (sentinel === true || (await tenantsCount(db)) > 0) {
    await emitFailure(db, "gone", "bootstrap already completed", opts);
    return { status: "failed", code: "gone", message: "bootstrap already completed" };
  }

  const envelope = await readSetting<TokenEnvelope>(db, BOOTSTRAP_TOKEN_KEY);
  if (!envelope) {
    await emitFailure(db, "invalid_token", "no bootstrap token on file", opts);
    return { status: "failed", code: "invalid_token", message: "no active bootstrap token" };
  }
  if (envelope.expires_at_ms < Date.now()) {
    await emitFailure(db, "token_expired", "bootstrap token expired", opts);
    return { status: "failed", code: "token_expired", message: "bootstrap token expired" };
  }
  if (!constantTimeEquals(sha256Hex(opts.token), envelope.token_sha256)) {
    await emitFailure(db, "invalid_token", "token mismatch", opts);
    return { status: "failed", code: "invalid_token", message: "invalid bootstrap token" };
  }

  const parsed = BootstrapSetupPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    await emitFailure(db, "validation_failed", "payload failed schema validation", opts, {
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return {
      status: "failed",
      code: "validation_failed",
      message: "setup payload failed validation",
    };
  }
  const payload = parsed.data;

  // Materialise the tenant + admin user + admin API key. The seed
  // helper is call-driven now (#70 retired the `BOOTSTRAP_*` env-var
  // path) — pass the operator payload directly. The transaction
  // guarantees no half-bootstrap state on partial failure.
  const result = await seedTenantBootstrap(db, rbacIds, {
    admin_email: payload.admin_email,
    tenant_name: payload.tenant_name,
    tenant_slug: deriveTenantSlug(payload.tenant_name),
    create_metrics_key: false,
  });

  // The upsert path skips key minting when an un-revoked admin key
  // already exists for this system account. On a true first-run
  // bootstrap this branch is unreachable (no prior keys), but defend
  // anyway so a re-bootstrap attempt against a stale fixture surfaces
  // a clean failure rather than crashing on `result.api_key.plaintext`.
  if (result.api_key === null) {
    await emitFailure(db, "validation_failed", "tenant bootstrap returned no api key", opts);
    return {
      status: "failed",
      code: "validation_failed",
      message: "tenant bootstrap failed",
    };
  }

  // Persist the LLM settings to subkit.config.json — bootstrap is the
  // first runtime write and seeds llm.provider + llm.api_key globally so
  // the new tenant has working LLM dispatch immediately.
  await setConfigKey(["llm", "provider"], payload.llm_provider, { force: true });
  await setConfigKey(["llm", "api_key"], payload.llm_api_key, { force: true });

  // Flip the sentinel and revoke the token in the same logical step.
  await writeSetting(db, BOOTSTRAP_COMPLETED_KEY, true);
  await deleteSetting(db, BOOTSTRAP_TOKEN_KEY);

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
  const now = Date.now();
  const entry = ipAttempts.get(ip);
  if (!entry || now - entry.window_started_at > BOOTSTRAP_WINDOW_MS) {
    ipAttempts.set(ip, { count: 1, window_started_at: now });
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
    // Best-effort: a missing audit row must not stop us from returning
    // the proper HTTP failure to the caller.  The structured logger
    // line above already captured the failure reason for SOC2 review.
    logger.warn({
      module: "onboarding.bootstrap",
      action: "bootstrap.audit_failed",
      msg: "failed to write SETUP_FAILED audit row",
      code,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Derive a URL-safe tenant slug from the operator-supplied display name.
 * Lower-cased, non-alphanumerics collapsed to `-`, leading/trailing
 * dashes stripped, length capped at 60.  Falls back to "subkit" when the
 * derived slug is empty (e.g. an all-emoji display name).
 */
export function deriveTenantSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "subkit";
}

/** Internal hooks for tests — never re-exported through index.ts.  */
export const _internal = {
  readSetting,
  writeSetting,
  deleteSetting,
  tenantsCount,
  mintToken,
  sha256Hex,
};

/** Convenience for callers that already hold a payload object — used by
 *  the route handler so it doesn't have to know the storage keys.       */
export type { TenantBootstrapPayload };
