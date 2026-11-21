import { createHmac, createPublicKey, verify } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import * as jose from "jose";
import { browserSessionSecret } from "../auth/browser-session.ts";
import type { AuthDenial, DenyingAuthProvider, ResolvedPrincipal } from "../auth/types.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  cockpitInstallations,
  deviceRunnerNonces,
  deviceRunners,
  users,
} from "../db/schema/index.ts";
import {
  checkRunnerAssertion,
  nonceExpiresAt,
  RUNNER_TOKEN_PREFIX,
  RUNNER_TOKEN_TTL_MS,
} from "./core/assertion.ts";

const TOKEN_AUDIENCE = "device-runner";
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

function tokenSecret(): Uint8Array {
  return new Uint8Array(
    createHmac("sha256", browserSessionSecret()).update("device-runner-token").digest(),
  );
}

export interface RunnerIdentity {
  device_id: string;
  tenant_id: string;
  installation_id: string;
  owner_user_id: string;
  device_label: string;
}

export type RunnerStanding =
  | { ok: true; runner: RunnerIdentity & { public_key: string } }
  | { ok: false };

export async function runnerStanding(db: Executor, device_id: string): Promise<RunnerStanding> {
  // tenant-filter:exempt — the runner id is the credential subject; the tenant comes from this row
  const [row] = await db
    .select({
      device_id: deviceRunners.id,
      tenant_id: deviceRunners.tenant_id,
      installation_id: deviceRunners.installation_id,
      owner_user_id: deviceRunners.owner_user_id,
      device_label: deviceRunners.device_label,
      public_key: deviceRunners.public_key,
      runner_revoked: deviceRunners.revoked_at,
      installation_revoked: cockpitInstallations.revoked_at,
      owner_status: users.status,
      owner_deleted: users.deleted_at,
    })
    .from(deviceRunners)
    .innerJoin(
      cockpitInstallations,
      and(
        eq(cockpitInstallations.tenant_id, deviceRunners.tenant_id),
        eq(cockpitInstallations.id, deviceRunners.installation_id),
      ),
    )
    .innerJoin(
      users,
      and(eq(users.tenant_id, deviceRunners.tenant_id), eq(users.id, deviceRunners.owner_user_id)),
    )
    .where(eq(deviceRunners.id, device_id))
    .limit(1);
  if (
    !row ||
    row.runner_revoked !== null ||
    row.installation_revoked !== null ||
    row.owner_status !== "active" ||
    row.owner_deleted !== null
  )
    return { ok: false };
  return {
    ok: true,
    runner: {
      device_id: row.device_id,
      tenant_id: row.tenant_id,
      installation_id: row.installation_id,
      owner_user_id: row.owner_user_id,
      device_label: row.device_label,
      public_key: row.public_key,
    },
  };
}

function signatureValid(publicKeyPem: string, assertion: string, signature: string): boolean {
  if (!SIGNATURE.test(signature)) return false;
  try {
    return verify(
      null,
      Buffer.from(assertion, "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export type TokenExchange =
  | { ok: true; access_token: string; expires_at: string }
  | { ok: false; status: 401 | 403; code: string };

export async function exchangeRunnerAssertion(
  db: Db,
  body: { assertion: string; signature: string },
  now_ms: number,
): Promise<TokenExchange> {
  const checked = checkRunnerAssertion(body.assertion, now_ms);
  if (!checked.ok) return { ok: false, status: 401, code: checked.code };
  const { device_runner_id, iat_ms, nonce } = checked.assertion;
  const standing = await runnerStanding(db, device_runner_id);
  if (!standing.ok) return { ok: false, status: 403, code: "device_revoked" };
  const { runner } = standing;
  if (!signatureValid(runner.public_key, body.assertion, body.signature))
    return { ok: false, status: 401, code: "assertion_signature_invalid" };
  const fresh = await db.transaction(async (tx) => {
    await tx
      .delete(deviceRunnerNonces)
      .where(
        and(
          eq(deviceRunnerNonces.tenant_id, runner.tenant_id),
          eq(deviceRunnerNonces.device_runner_id, runner.device_id),
          lt(deviceRunnerNonces.expires_at, sql`clock_timestamp()`),
        ),
      );
    return tx
      .insert(deviceRunnerNonces)
      .values({
        tenant_id: runner.tenant_id,
        device_runner_id: runner.device_id,
        nonce,
        expires_at: new Date(nonceExpiresAt(iat_ms)),
      })
      .onConflictDoNothing()
      .returning({ nonce: deviceRunnerNonces.nonce });
  });
  if (fresh.length === 0) return { ok: false, status: 401, code: "assertion_replayed" };
  const expires_ms = now_ms + RUNNER_TOKEN_TTL_MS;
  const jwt = await new jose.SignJWT({
    tid: runner.tenant_id,
    iid: runner.installation_id,
    uid: runner.owner_user_id,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(runner.device_id)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt(Math.floor(now_ms / 1000))
    .setExpirationTime(Math.floor(expires_ms / 1000))
    .sign(tokenSecret());
  return {
    ok: true,
    access_token: `${RUNNER_TOKEN_PREFIX}${jwt}`,
    expires_at: new Date(Math.floor(expires_ms / 1000) * 1000).toISOString(),
  };
}

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header || header.slice(0, 7).toLowerCase() !== "bearer ") return null;
  const token = header.slice(7).trim();
  return token.startsWith(RUNNER_TOKEN_PREFIX) ? token.slice(RUNNER_TOKEN_PREFIX.length) : null;
}

export function runnerPrincipal(runner: RunnerIdentity): ResolvedPrincipal {
  return {
    provider: "device_runner",
    kind: "user",
    id: runner.owner_user_id,
    tenant_id: runner.tenant_id,
    roles: [],
    installation_id: runner.installation_id,
    auth_source: {
      kind: "device_runner",
      device_id: runner.device_id,
      installation_id: runner.installation_id,
    },
  };
}

export function isRunnerPrincipal(principal: ResolvedPrincipal | undefined): boolean {
  return principal?.auth_source?.kind === "device_runner";
}

export function createDeviceRunnerProvider(opts: { db: Db }): DenyingAuthProvider {
  const deny = (reason: string): AuthDenial => ({
    denied: true,
    provider: "device_runner",
    reason,
  });
  return {
    name: "device_runner",
    capabilities: { human: false, machine: true, interactive: false, refresh: false, revoke: true },
    claims: (req) => bearer(req) !== null,
    async resolve(req) {
      const token = bearer(req);
      if (token === null) return null;
      let payload: jose.JWTPayload;
      try {
        payload = (
          await jose.jwtVerify(token, tokenSecret(), {
            audience: TOKEN_AUDIENCE,
            algorithms: ["HS256"],
          })
        ).payload;
      } catch {
        return deny("token_invalid");
      }
      if (typeof payload.sub !== "string") return deny("token_invalid");
      const standing = await runnerStanding(opts.db, payload.sub);
      if (
        !standing.ok ||
        standing.runner.tenant_id !== payload.tid ||
        standing.runner.installation_id !== payload.iid ||
        standing.runner.owner_user_id !== payload.uid
      )
        return deny("device_revoked");
      return runnerPrincipal(standing.runner);
    },
  };
}
