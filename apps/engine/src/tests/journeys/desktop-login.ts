import { createPkcePair, createState, sameState } from "../../../../desktop/src/shared/pkce.ts";
import {
  apiUrl,
  type DesktopSession,
  LOGIN_CALLBACK,
  loginStartUrl,
  parseDesktopSession,
  type ServiceDescriptor,
} from "../../../../desktop/src/shared/server-contract.ts";
import { CSRF_HEADER } from "../../../../desktop/src/shared/workspace-requests.ts";
import type { JourneyCtx } from "./setup.ts";

export function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function keep(jar: Map<string, string>, res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
}

export function uuidFrom(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function decodeAmp(value: string): string {
  return value.replaceAll("&amp;", "&");
}

export interface Browser {
  jar: Map<string, string>;
  request(url: string, init?: RequestInit): Promise<Response>;
  walk(startUrl: string): Promise<URL>;
}

export function createBrowser(ctx: JourneyCtx): Browser {
  const jar = new Map<string, string>();
  const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (!headers.has("accept")) headers.set("accept", "text/html");
    if (jar.size) headers.set("cookie", cookieHeader(jar));
    const res = await fetch(new URL(url, ctx.baseUrl), { ...init, headers, redirect: "manual" });
    keep(jar, res);
    return res;
  };
  const walk = async (startUrl: string): Promise<URL> => {
    let res = await request(startUrl);
    for (let hop = 0; hop < 12; hop++) {
      const location = res.headers.get("location");
      if (location?.startsWith(LOGIN_CALLBACK)) return new URL(location);
      if (location) {
        res = await request(location);
        continue;
      }
      const html = await res.text();
      const form = html.match(/<form[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/);
      const provider = html.match(/href="([^"]*provider=api-key[^"]*)"/)?.[1];
      if (!form && provider) {
        res = await request(decodeAmp(provider));
        continue;
      }
      if (!form) throw new Error(`browser step without a form (status ${res.status})`);
      const fields = new URLSearchParams();
      for (const tag of form[2]?.match(/<input[^>]*>/g) ?? []) {
        const name = tag.match(/name="([^"]+)"/)?.[1];
        if (name) fields.set(name, decodeAmp(tag.match(/value="([^"]*)"/)?.[1] ?? ""));
      }
      if (fields.has("api_key")) fields.set("api_key", ctx.apiKey);
      const buttons = [
        ...(form[2] ?? "").matchAll(/<button[^>]*name="([^"]+)"[^>]*value="([^"]+)"/g),
      ];
      const approve = buttons.find((b) => /approve|allow|confirm|accept/i.test(b[2] ?? ""));
      if (approve?.[1] && approve[2]) fields.set(approve[1], approve[2]);
      res = await request(decodeAmp(form[1] ?? "") || startUrl, {
        method: "POST",
        body: fields,
        headers: { origin: ctx.baseUrl, "content-type": "application/x-www-form-urlencoded" },
      });
    }
    throw new Error("the browser never reached the app callback");
  };
  return { jar, request, walk };
}

export interface DeviceSignIn {
  callback: URL;
  stateMatches: boolean;
  status: number;
  session: DesktopSession | null;
  cookie: string;
}

export async function signInDevice(
  ctx: JourneyCtx,
  browser: Browser,
  descriptor: ServiceDescriptor,
  device: { id: string; label: string; appVersion: string },
): Promise<DeviceSignIn> {
  const desktop = descriptor.desktop;
  if (!desktop) throw new Error("descriptor names no desktop client");
  const pkce = createPkcePair(ctx.random.bytes(32));
  const state = createState(ctx.random.bytes(24));
  const start = loginStartUrl(ctx.baseUrl, desktop.login, {
    challenge: pkce.challenge,
    state,
    deviceId: device.id,
    deviceLabel: device.label,
    callback: LOGIN_CALLBACK,
    appVersion: device.appVersion,
  });
  const callback = await browser.walk(start);
  const code = callback.searchParams.get("code");
  const exchanged = await fetch(`${ctx.baseUrl}${desktop.login.session}`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "none" },
    body: JSON.stringify({
      code,
      code_verifier: pkce.verifier,
      state,
      app_version: device.appVersion,
    }),
  });
  const jar = new Map<string, string>();
  keep(jar, exchanged);
  return {
    callback,
    stateMatches: sameState(state, callback.searchParams.get("state") ?? ""),
    status: exchanged.status,
    session: exchanged.ok ? parseDesktopSession(await exchanged.json()) : null,
    cookie: cookieHeader(jar),
  };
}

export function deviceRequest(
  ctx: JourneyCtx,
  device: { session: DesktopSession; cookie: string; csrf: string },
) {
  return (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("cookie", device.cookie);
    if (init.method && init.method !== "GET") {
      headers.set(CSRF_HEADER, device.csrf);
      headers.set("origin", ctx.baseUrl);
      headers.set("sec-fetch-site", "same-origin");
      if (init.body) headers.set("content-type", "application/json");
    }
    return fetch(apiUrl(ctx.baseUrl, device.session.cockpitPath, path), { ...init, headers });
  };
}
