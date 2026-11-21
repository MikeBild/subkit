import { and, eq, isNull, lt, or } from "drizzle-orm";
import * as jose from "jose";
import { z } from "zod";
import { getConfig } from "../config/loader.ts";
import { DESKTOP_MIN_VERSION_DEFAULT } from "../config/schema.ts";
import type { Db } from "../db/client.ts";
import { desktopLoginCodes, users } from "../db/schema/index.ts";
import { readEnv } from "../env.ts";
import { browserSessionSecret } from "./browser-session.ts";
import {
  constantTimeHexEquals,
  generateAuthorizationCode,
  sha256Hex,
  verifyS256,
} from "./oauth/tokens.ts";

export const DESKTOP_LOGIN_START_PATH = "/v1/identity/desktop-login/start";
export const DESKTOP_LOGIN_CONFIRM_PATH = "/v1/identity/desktop-login/confirm";
export const DESKTOP_SESSION_PATH = "/v1/identity/desktop-session";
export const DESKTOP_LOGIN_CALLBACK = "subkit://callback";
export const DESKTOP_LOGIN_DEV_CALLBACK = "subkit-dev://callback";
export const DESKTOP_LOGIN_CODE_TTL_MS = 60_000;
export const DESKTOP_LOGIN_REQUEST_TTL_SECONDS = 600;

const REQUEST_PURPOSE = "desktop_login_request";
const CONFIRM_PURPOSE = "desktop_login_confirm";
const CONTROL_CHARACTERS = /\p{Cc}/u;

const CodeChallenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const State = z.string().regex(/^[A-Za-z0-9._~-]{16,128}$/);
const DeviceLabel = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !CONTROL_CHARACTERS.test(value), "device_label has control characters");

const AppVersion = z
  .string()
  .regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/)
  .describe(
    "Version of the desktop app that asks, for example 0.1.0. A version below server.desktop_min_version, or none at all, is refused with desktop_app_outdated.",
  );

export const DESKTOP_APP_OUTDATED = "desktop_app_outdated";

function versionParts(version: string): [number, number, number, boolean] | null {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-.+)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Boolean(match[4])];
}

export function desktopAppVersionAccepted(
  appVersion: string | undefined,
  minVersion: string,
): boolean {
  const app = appVersion === undefined ? null : versionParts(appVersion);
  const min = versionParts(minVersion);
  if (!app || !min) return false;
  for (const index of [0, 1, 2] as const) {
    if (app[index] !== min[index]) return app[index] > min[index];
  }
  return !app[3] || min[3];
}

export function desktopMinVersion(): string {
  try {
    return getConfig().server.desktop_min_version;
  } catch {
    return DESKTOP_MIN_VERSION_DEFAULT;
  }
}

export const DesktopLoginStartQuerySchema = z
  .object({
    code_challenge: CodeChallenge,
    code_challenge_method: z.literal("S256"),
    state: State,
    device_id: z.string().uuid(),
    device_label: DeviceLabel,
    redirect_uri: z.enum([DESKTOP_LOGIN_CALLBACK, DESKTOP_LOGIN_DEV_CALLBACK]).optional(),
    app_version: AppVersion.optional(),
  })
  .strict();

export function desktopLoginCallbacks(mode: {
  production: boolean;
  dev_callback: boolean;
}): readonly string[] {
  return mode.production && !mode.dev_callback
    ? [DESKTOP_LOGIN_CALLBACK]
    : [DESKTOP_LOGIN_CALLBACK, DESKTOP_LOGIN_DEV_CALLBACK];
}

export function allowedDesktopLoginCallbacks(): readonly string[] {
  let configured = false;
  try {
    configured = getConfig().server.desktop_dev_callback;
  } catch {}
  return desktopLoginCallbacks({
    production: readEnv("NODE_ENV") === "production",
    dev_callback: configured,
  });
}

export function desktopLoginCallbackFor(
  requested: string | undefined,
  allowed: readonly string[],
): string | null {
  const target = requested ?? DESKTOP_LOGIN_CALLBACK;
  return allowed.includes(target) ? target : null;
}

export const DesktopSessionRequestSchema = z
  .object({
    code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    state: State.optional(),
    app_version: AppVersion.optional(),
  })
  .strict();

export interface DesktopLoginRequest {
  code_challenge: string;
  state: string;
  device_id: string;
  device_label: string;
  redirect_uri?: string | undefined;
  app_version?: string | undefined;
}

const DesktopLoginRequestSchema = z.object({
  code_challenge: CodeChallenge,
  state: State,
  device_id: z.string().uuid(),
  device_label: DeviceLabel,
  redirect_uri: z.literal(DESKTOP_LOGIN_DEV_CALLBACK).optional(),
  app_version: AppVersion.optional(),
});

export async function signDesktopLoginRequest(
  request: DesktopLoginRequest,
  at: Date = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(at.getTime() / 1000);
  return new jose.SignJWT({ purpose: REQUEST_PURPOSE, ...request })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + DESKTOP_LOGIN_REQUEST_TTL_SECONDS)
    .sign(browserSessionSecret());
}

export async function verifyDesktopLoginRequest(
  token: string,
  at: Date = new Date(),
): Promise<DesktopLoginRequest | null> {
  try {
    const { payload } = await jose.jwtVerify(token, browserSessionSecret(), {
      algorithms: ["HS256"],
      currentDate: at,
    });
    if (payload.purpose !== REQUEST_PURPOSE) return null;
    const parsed = DesktopLoginRequestSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function signDesktopLoginConfirmation(
  sessionId: string,
  requestToken: string,
  at: Date = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(at.getTime() / 1000);
  return new jose.SignJWT({
    purpose: CONFIRM_PURPOSE,
    session_id: sessionId,
    request_sha256: sha256Hex(requestToken),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + DESKTOP_LOGIN_REQUEST_TTL_SECONDS)
    .sign(browserSessionSecret());
}

export async function verifyDesktopLoginConfirmation(
  token: string,
  sessionId: string,
  requestToken: string,
  at: Date = new Date(),
): Promise<boolean> {
  try {
    const { payload } = await jose.jwtVerify(token, browserSessionSecret(), {
      algorithms: ["HS256"],
      currentDate: at,
    });
    return (
      payload.purpose === CONFIRM_PURPOSE &&
      payload.session_id === sessionId &&
      typeof payload.request_sha256 === "string" &&
      constantTimeHexEquals(payload.request_sha256, sha256Hex(requestToken))
    );
  } catch {
    return false;
  }
}

export function desktopLoginCallbackUrl(
  result: { code: string; state: string } | { error: "access_denied"; state: string },
  callback: string = DESKTOP_LOGIN_CALLBACK,
): string {
  const params = new URLSearchParams(
    "code" in result
      ? { code: result.code, state: result.state }
      : { error: result.error, state: result.state },
  );
  return `${callback}?${params.toString()}`;
}

export function isDesktopLoginCallbackUrl(
  candidate: string,
  allowed: readonly string[] = [DESKTOP_LOGIN_CALLBACK],
): boolean {
  const callback = allowed.find((entry) => candidate.startsWith(`${entry}?`));
  if (!callback) return false;
  try {
    const url = new URL(candidate);
    return (
      `${url.protocol}//${url.hostname}` === callback &&
      url.hostname === "callback" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export type DesktopLoginCodeRejection =
  | "unknown_code"
  | "replayed"
  | "expired"
  | "invalid_verifier"
  | "state_mismatch"
  | "user_inactive";

export interface DesktopLoginCodeFacts {
  code_challenge: string;
  state_sha256: string;
  expires_at: Date;
  consumed_at: Date | null;
}

export function desktopLoginCodeRejection(
  facts: DesktopLoginCodeFacts,
  attempt: { code_verifier: string; state?: string | undefined; now: Date },
): DesktopLoginCodeRejection | null {
  if (facts.consumed_at) return "replayed";
  if (facts.expires_at.getTime() <= attempt.now.getTime()) return "expired";
  if (!verifyS256(attempt.code_verifier, facts.code_challenge)) return "invalid_verifier";
  if (
    attempt.state !== undefined &&
    !constantTimeHexEquals(sha256Hex(attempt.state), facts.state_sha256)
  )
    return "state_mismatch";
  return null;
}

export async function issueDesktopLoginCode(
  db: Db,
  input: {
    tenant_id: string;
    user_id: string;
    auth_identity_id: string | null;
    request: DesktopLoginRequest;
    now?: Date;
  },
): Promise<{ id: string; code: string; expires_at: Date }> {
  const at = input.now ?? new Date();
  const issued = generateAuthorizationCode();
  const expiresAt = new Date(at.getTime() + DESKTOP_LOGIN_CODE_TTL_MS);
  return await db.transaction(async (tx) => {
    await tx
      .delete(desktopLoginCodes)
      .where(
        and(
          eq(desktopLoginCodes.tenant_id, input.tenant_id),
          eq(desktopLoginCodes.user_id, input.user_id),
          or(
            lt(desktopLoginCodes.expires_at, at),
            and(
              eq(desktopLoginCodes.device_id, input.request.device_id),
              isNull(desktopLoginCodes.consumed_at),
            ),
          ),
        ),
      );
    const [row] = await tx
      .insert(desktopLoginCodes)
      .values({
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        auth_identity_id: input.auth_identity_id,
        code_sha256: issued.hash,
        code_challenge: input.request.code_challenge,
        state_sha256: sha256Hex(input.request.state),
        device_id: input.request.device_id,
        device_label: input.request.device_label,
        expires_at: expiresAt,
      })
      .returning({ id: desktopLoginCodes.id });
    if (!row) throw new Error("desktop login code was not stored");
    return { id: row.id, code: issued.plaintext, expires_at: expiresAt };
  });
}

export interface DesktopLoginGrant {
  code_id: string;
  tenant_id: string;
  user_id: string;
  auth_identity_id: string | null;
  device_id: string;
  device_label: string;
}

export type DesktopLoginCodeOutcome =
  | { ok: true; grant: DesktopLoginGrant }
  | {
      ok: false;
      reason: DesktopLoginCodeRejection;
      subject: Pick<DesktopLoginGrant, "code_id" | "tenant_id" | "user_id" | "device_id"> | null;
    };

export async function consumeDesktopLoginCode(
  db: Db,
  attempt: { code: string; code_verifier: string; state?: string | undefined; now?: Date },
): Promise<DesktopLoginCodeOutcome> {
  const at = attempt.now ?? new Date();
  const hash = sha256Hex(attempt.code);
  // tenant-filter:exempt — the one-time code is presented before any tenant is authenticated; its row names the tenant.
  const [claimed] = await db
    .update(desktopLoginCodes)
    .set({ consumed_at: at })
    .where(and(eq(desktopLoginCodes.code_sha256, hash), isNull(desktopLoginCodes.consumed_at)))
    .returning();
  if (!claimed) {
    // tenant-filter:exempt — replay detection reads the already consumed code by its hash before any tenant is authenticated.
    const [seen] = await db
      .select({
        id: desktopLoginCodes.id,
        tenant_id: desktopLoginCodes.tenant_id,
        user_id: desktopLoginCodes.user_id,
        device_id: desktopLoginCodes.device_id,
      })
      .from(desktopLoginCodes)
      .where(eq(desktopLoginCodes.code_sha256, hash))
      .limit(1);
    return seen
      ? {
          ok: false,
          reason: "replayed",
          subject: {
            code_id: seen.id,
            tenant_id: seen.tenant_id,
            user_id: seen.user_id,
            device_id: seen.device_id,
          },
        }
      : { ok: false, reason: "unknown_code", subject: null };
  }
  const subject = {
    code_id: claimed.id,
    tenant_id: claimed.tenant_id,
    user_id: claimed.user_id,
    device_id: claimed.device_id,
  };
  const rejection = desktopLoginCodeRejection(
    { ...claimed, consumed_at: null },
    { code_verifier: attempt.code_verifier, state: attempt.state, now: at },
  );
  if (rejection) return { ok: false, reason: rejection, subject };
  const [user] = await db
    .select({ status: users.status, deleted_at: users.deleted_at })
    .from(users)
    .where(and(eq(users.id, claimed.user_id), eq(users.tenant_id, claimed.tenant_id)))
    .limit(1);
  if (user?.status !== "active" || user.deleted_at)
    return { ok: false, reason: "user_inactive", subject };
  return {
    ok: true,
    grant: {
      ...subject,
      auth_identity_id: claimed.auth_identity_id,
      device_label: claimed.device_label,
    },
  };
}

interface RateWindow {
  count: number;
  started: number;
}

export function createDesktopLoginRateLimiter(limits: { max: number; windowMs: number }): {
  take: (key: string, now?: number) => { allowed: boolean; retry_after_seconds: number };
} {
  const windows = new Map<string, RateWindow>();
  let lastPrune = 0;
  return {
    take(key, now = Date.now()) {
      if (now - lastPrune > limits.windowMs) {
        for (const [seen, window] of windows)
          if (now - window.started >= limits.windowMs) windows.delete(seen);
        lastPrune = now;
      }
      const current = windows.get(key);
      if (!current || now - current.started >= limits.windowMs) {
        windows.set(key, { count: 1, started: now });
        return { allowed: true, retry_after_seconds: 0 };
      }
      current.count++;
      if (current.count <= limits.max) return { allowed: true, retry_after_seconds: 0 };
      return {
        allowed: false,
        retry_after_seconds: Math.max(
          1,
          Math.ceil((current.started + limits.windowMs - now) / 1000),
        ),
      };
    },
  };
}
