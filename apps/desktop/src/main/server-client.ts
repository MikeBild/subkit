import { net, type Session } from "electron";
import type { AnonymousReportBody } from "../shared/anonymous-report.ts";
import { type AttentionItem, parseAttention } from "../shared/attention.ts";
import {
  INVITE_PREVIEW_PATH,
  type InviteLink,
  type InvitePreview,
  invitePreviewBody,
  parseInvitePreview,
} from "../shared/invite-link.ts";
import type { CheckResult } from "../shared/ipc.ts";
import { normalizeServerAddress } from "../shared/server-address.ts";
import {
  ATTENTION_PATH,
  type AuthFailure,
  acceptsCallback,
  apiUrl,
  appVersionParam,
  classifyAuthFailure,
  classifyExchangeFailure,
  DESCRIPTOR_PATH,
  type DesktopSession,
  type ExchangeFailure,
  type LoginPaths,
  MIN_SERVER_VERSION,
  parseDescriptor,
  parseDesktopSession,
  type ServiceDescriptor,
} from "../shared/server-contract.ts";
import { handshake } from "../shared/version.ts";

const REQUEST_TIMEOUT_MS = 15_000;

export interface ServerCheck {
  result: CheckResult;
  descriptor: ServiceDescriptor | null;
}

function failed(status: CheckResult["status"], origin: string | null): ServerCheck {
  return {
    result: {
      status,
      origin,
      serverVersion: null,
      minAppVersion: null,
      minServerVersion: MIN_SERVER_VERSION,
    },
    descriptor: null,
  };
}

export async function checkServer(
  address: string,
  appVersion: string,
  callback: string,
): Promise<ServerCheck> {
  const normalized = normalizeServerAddress(address);
  if (!normalized.ok) return failed(normalized.problem, null);
  const { origin } = normalized;
  let response: Response;
  try {
    response = await net.fetch(`${origin}${DESCRIPTOR_PATH}`, {
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return failed("unreachable", origin);
  }
  if (response.status >= 500) return failed("unreachable", origin);
  if (!response.ok) return failed("not-subkit", origin);
  const descriptor = parseDescriptor(await response.json().catch(() => null));
  if (!descriptor) return failed("not-subkit", origin);
  return {
    descriptor,
    result: {
      status: handshake({
        appVersion,
        serverVersion: descriptor.version,
        minServerVersion: MIN_SERVER_VERSION,
        minAppVersion: descriptor.desktop?.minVersion ?? null,
        desktopSupported: descriptor.desktop !== null,
        loginSupported: acceptsCallback(descriptor.desktop, callback),
      }),
      origin,
      serverVersion: descriptor.version,
      minAppVersion: descriptor.desktop?.minVersion ?? null,
      minServerVersion: MIN_SERVER_VERSION,
    },
  };
}

export async function sendAnonymousReport(
  origin: string,
  path: string,
  body: AnonymousReportBody,
): Promise<number | null> {
  try {
    const response = await net.fetch(`${origin}${path}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.status;
  } catch {
    return null;
  }
}

export async function previewInvite(link: InviteLink): Promise<InvitePreview | null> {
  try {
    const response = await net.fetch(`${link.origin}${INVITE_PREVIEW_PATH}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: invitePreviewBody(link),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 500) return null;
    return parseInvitePreview(
      response.status,
      await response.json().catch(() => null),
      link.origin,
    );
  } catch {
    return null;
  }
}

export type ExchangeResult =
  | { ok: true; session: DesktopSession }
  | { ok: false; reason: ExchangeFailure };

export async function exchangeDesktopSession(
  session: Session,
  origin: string,
  paths: LoginPaths,
  grant: { code: string; verifier: string; state: string; appVersion: string },
): Promise<ExchangeResult> {
  let response: Response;
  try {
    response = await session.fetch(`${origin}${paths.session}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        code: grant.code,
        code_verifier: grant.verifier,
        state: grant.state,
        app_version: appVersionParam(grant.appVersion),
      }),
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) return { ok: false, reason: classifyExchangeFailure(response.status) };
  const parsed = parseDesktopSession(await response.json().catch(() => null));
  return parsed ? { ok: true, session: parsed } : { ok: false, reason: "rejected" };
}

export type AttentionResult =
  | { ok: true; items: AttentionItem[] }
  | { ok: false; failure: AuthFailure | "unavailable" };

export async function fetchAttention(
  session: Session,
  origin: string,
  cockpitPath: string,
): Promise<AttentionResult> {
  let response: Response;
  try {
    response = await session.fetch(apiUrl(origin, cockpitPath, ATTENTION_PATH), {
      headers: { accept: "application/json" },
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, failure: "unavailable" };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, failure: classifyAuthFailure(response.status, body) ?? "unavailable" };
  }
  const items = parseAttention(body);
  return items ? { ok: true, items } : { ok: false, failure: "unavailable" };
}
