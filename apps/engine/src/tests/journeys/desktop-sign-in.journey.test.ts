import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  applyOutcome,
  classifyOutcome,
  due,
  enqueue,
  type OfflineItem,
  summarize,
} from "../../../../../packages/shared/src/offline-queue.ts";
import { parsePause, pauseToggle, trayMute } from "../../../../desktop/src/shared/pause-model.ts";
import {
  ATTENTION_PATH,
  apiUrl,
  classifyAuthFailure,
  DESCRIPTOR_PATH,
  type DesktopSession,
  LOGIN_CALLBACK,
  parseDescriptor,
  type ServiceDescriptor,
} from "../../../../desktop/src/shared/server-contract.ts";
import {
  BOOTSTRAP_PATH,
  CSRF_HEADER,
  parseCsrfToken,
} from "../../../../desktop/src/shared/workspace-requests.ts";
import { type Browser, createBrowser, signInDevice, uuidFrom } from "./desktop-login.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const APP_VERSION = "11.2.0";
const DEVICE_LABEL = "Annas MacBook";
const QUIET = { enabled: true, start: "22:00", end: "07:00" };

let ctx: JourneyCtx;
let descriptor: ServiceDescriptor;
let deviceId = "";
let session: DesktopSession;
let deviceCookie = "";
let deviceCsrf = "";
let browserClient: Browser;

beforeAll(async () => {
  ctx = await createJourneyCtx("desktop-sign-in");
  browserClient = createBrowser(ctx);
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

function deviceFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("cookie", deviceCookie);
  if (init.method && init.method !== "GET") {
    headers.set(CSRF_HEADER, deviceCsrf);
    headers.set("origin", ctx.baseUrl);
    headers.set("sec-fetch-site", "same-origin");
    if (init.body) headers.set("content-type", "application/json");
  }
  return fetch(apiUrl(ctx.baseUrl, session.cockpitPath, path), { ...init, headers });
}

async function auditActions(action: string): Promise<string[]> {
  const res = await journeyFetch(ctx, `/v1/audit-log?action=${action}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ action: string }> };
  return body.items.map((item) => item.action).filter((name) => name === action);
}

describe("the desktop app signs in through the browser and the person works with it", () => {
  test("the server tells the app how to sign in", async () => {
    const res = await fetch(`${ctx.baseUrl}${DESCRIPTOR_PATH}`);
    expect(res.status).toBe(200);
    const parsed = parseDescriptor(await res.json());
    expect(parsed?.desktop?.loginSupported).toBe(true);
    expect(parsed?.desktop?.callbacks).toContain(LOGIN_CALLBACK);
    descriptor = parsed as ServiceDescriptor;
  });

  test("the browser sign-in hands the app a code for its own state and the app becomes a registered device", async () => {
    deviceId = uuidFrom(ctx.random.bytes(16));
    const signed = await signInDevice(ctx, browserClient, descriptor, {
      id: deviceId,
      label: DEVICE_LABEL,
      appVersion: APP_VERSION,
    });
    expect(signed.callback.searchParams.get("code")).toBeTruthy();
    expect(signed.stateMatches).toBe(true);
    expect(signed.status).toBe(200);
    expect(signed.session).not.toBeNull();
    session = signed.session as DesktopSession;
    deviceCookie = signed.cookie;
    expect(deviceCookie).not.toBe("");
  });

  test("the device is listed as the person's installation and its sign-in is audited", async () => {
    const list = await browserClient.request("/v1/cockpit/installations", {
      headers: { accept: "application/json" },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { installations: Array<{ id: string }> };
    expect(body.installations.map((i) => i.id)).toContain(session.installationId);

    expect(await auditActions("desktop_login.completed")).toHaveLength(1);
  });

  test("the Cockpit answers through the installation path with the device session", async () => {
    const boot = await deviceFetch(BOOTSTRAP_PATH);
    expect(boot.status).toBe(200);
    const token = parseCsrfToken(await boot.json());
    expect(token).not.toBeNull();
    deviceCsrf = token as string;

    const attention = await deviceFetch(ATTENTION_PATH);
    expect(attention.status).toBe(200);
    expect(await attention.json()).toHaveProperty("items");
  });

  test("feedback written offline waits in the queue and is filed once the device is back", async () => {
    let online = false;
    const filed: string[] = [];
    const identity = { server: ctx.baseUrl, user_id: ctx.userId };
    type Report = { kind: "bug"; message: string };
    let queue: readonly OfflineItem<Report>[] = [];
    const flush = async () => {
      for (;;) {
        const item = due(queue, { ...identity, now: ctx.clock.now() });
        if (!item) return;
        const res = online
          ? await deviceFetch("/v1/feedback", {
              method: "POST",
              body: JSON.stringify({ ...item.payload, client_request_id: item.id }),
            })
          : null;
        if (res?.ok) filed.push(((await res.json()) as { intake_item_id: string }).intake_item_id);
        const outcome = classifyOutcome(res ? { status: res.status } : null);
        queue = applyOutcome(queue, item.id, outcome, ctx.clock.now(), 0);
        if (outcome.kind !== "delivered") return;
      }
    };
    const added = enqueue<Report>(
      queue,
      {
        id: uuidFrom(ctx.random.bytes(16)),
        kind: "feedback",
        payload: { kind: "bug", message: "Die Liste springt beim Scrollen nach oben." },
        ...identity,
      },
      ctx.clock.now(),
    );
    expect(added.ok).toBe(true);
    if (added.ok) queue = added.queue;

    await flush();
    expect(summarize(queue, identity).waiting).toBe(1);
    expect(filed).toEqual([]);

    online = true;
    ctx.clock.advanceBy(10 * 60_000);
    await flush();
    expect(summarize(queue, identity).waiting).toBe(0);
    expect(filed).toHaveLength(1);
    expect(await auditActions("feedback.submitted")).toHaveLength(1);

    const item = await journeyFetch(ctx, `/v1/intake/items/${filed[0]}`);
    expect(item.status).toBe(200);
    expect(JSON.stringify(await item.json())).toContain("springt beim Scrollen");
  });

  test("a personal pause silences the device until the person resumes", async () => {
    const pause = pauseToggle(false);
    expect(pause.method).toBe("PUT");
    const paused = await deviceFetch(
      "/v1/identity/me/notification-pause",
      pause.method === "PUT"
        ? { method: "PUT", body: JSON.stringify(pause.body) }
        : { method: "DELETE" },
    );
    expect(paused.status).toBe(200);

    const read = await deviceFetch("/v1/identity/me/notification-pause");
    const server = parsePause(await read.json());
    expect(server?.paused).toBe(true);
    const morning = new Date(2026, 5, 10, 9, 0).getTime();
    expect(
      trayMute({
        support: "server",
        server,
        held: null,
        quietHours: QUIET,
        localPauseUntil: null,
        now: Date.parse(server?.paused_at ?? "") || morning,
      })?.reason,
    ).toBe("paused");

    const resume = pauseToggle(true);
    expect(resume.method).toBe("DELETE");
    const resumed = await deviceFetch("/v1/identity/me/notification-pause", { method: "DELETE" });
    expect(resumed.status).toBe(200);
    const after = parsePause(
      await (await deviceFetch("/v1/identity/me/notification-pause")).json(),
    );
    expect(after?.paused).toBe(false);

    const mute = (at: number) =>
      trayMute({
        support: "server",
        server: after,
        held: null,
        quietHours: QUIET,
        localPauseUntil: null,
        now: at,
      });
    expect(mute(new Date(2026, 5, 10, 23, 0).getTime())?.reason).toBe("quiet-hours");
    expect(mute(morning)).toBeNull();

    expect(await auditActions("user.notifications_paused")).toHaveLength(1);
    expect(await auditActions("user.notifications_resumed")).toHaveLength(1);
  });

  test("revoking the device ends its session", async () => {
    const boot = await browserClient.request(BOOTSTRAP_PATH, {
      headers: { accept: "application/json" },
    });
    const csrf = parseCsrfToken(await boot.json());
    const revoke = await browserClient.request(
      `/v1/cockpit/installations/${session.installationId}`,
      {
        method: "DELETE",
        headers: {
          accept: "application/json",
          origin: ctx.baseUrl,
          "sec-fetch-site": "same-origin",
          [CSRF_HEADER]: csrf ?? "",
        },
      },
    );
    expect(revoke.ok).toBe(true);

    const refused = await deviceFetch(ATTENTION_PATH);
    expect(classifyAuthFailure(refused.status, await refused.json().catch(() => null))).toBe(
      "revoked",
    );
    expect(await auditActions("cockpit_installation.revoked")).toHaveLength(1);
  });
});
