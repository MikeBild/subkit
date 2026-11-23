import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { homeTarget } from "../../../../desktop/src/connect/domain/navigation-model.ts";
import { INITIAL_FLOW, screenFor } from "../../../../desktop/src/connect/domain/screens-model.ts";
import { settingsFor } from "../../../../desktop/src/connect/domain/settings-model.ts";
import {
  decide,
  evolve,
  INITIAL_STATE,
  type SignInState,
  viewOf,
} from "../../../../desktop/src/connect/domain/sign-in-model.ts";
import { appendError, buildDiagnostics } from "../../../../desktop/src/shared/diagnostics.ts";
import { dictionary } from "../../../../desktop/src/shared/i18n.ts";
import {
  type ConnectState,
  type ConnectView,
  LOCAL_UNAVAILABLE,
} from "../../../../desktop/src/shared/ipc.ts";
import { permissionsFrom } from "../../../../desktop/src/shared/local/permission-model.ts";
import {
  firstSetup,
  NO_ONBOARDING,
  setupComplete,
} from "../../../../desktop/src/shared/onboarding.ts";
import { platformCapabilities } from "../../../../desktop/src/shared/platform-capabilities.ts";
import {
  CLOSED_REPORT,
  DIAGNOSTICS_FILENAME,
  deliverReport,
  FEEDBACK_PATH,
  type ReportAnswer,
  reportBody,
  reportOutcome,
  reportTarget,
} from "../../../../desktop/src/shared/problem-report.ts";
import {
  activeProfile,
  emptyStore,
  type StoreData,
  upsertProfile,
} from "../../../../desktop/src/shared/profiles.ts";
import { hostOf } from "../../../../desktop/src/shared/server-address.ts";
import {
  ATTENTION_PATH,
  classifyAuthFailure,
  DESCRIPTOR_PATH,
  type DesktopSession,
  parseDescriptor,
  type ServiceDescriptor,
} from "../../../../desktop/src/shared/server-contract.ts";
import { profileSummaries } from "../../../../desktop/src/shared/shell-session.ts";
import {
  classifyUpdateError,
  initialUpdateState,
  reduceUpdate,
  type UpdateState,
  updateErrorEvent,
} from "../../../../desktop/src/shared/updates.ts";
import {
  BOOTSTRAP_PATH,
  parseCsrfToken,
} from "../../../../desktop/src/shared/workspace-requests.ts";
import { auditLog } from "../../db/schema/index.ts";
import {
  type Browser,
  createBrowser,
  deviceRequest,
  signInDevice,
  uuidFrom,
} from "./desktop-login.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const APP_VERSION = "12.1.5";
const DEVICE_LABEL = "Office laptop";

let ctx: JourneyCtx;
let browser: Browser;
let descriptor: ServiceDescriptor;
let deviceId = "";
let session: DesktopSession;
let cookie = "";
let csrf = "";
let store: StoreData;
let update: UpdateState = initialUpdateState(true);
let permissions = {
  supported: true,
  permissions: permissionsFrom(
    { accessibility: true, screen: "granted" },
    { accessibility: true, screen: "denied" },
  ),
  lost: [] as never[],
};

function asDevice(path: string, init: RequestInit = {}): Promise<Response> {
  return deviceRequest(ctx, { session, cookie, csrf })(path, init);
}

function iso(): string {
  return new Date(ctx.clock.now()).toISOString();
}

function connectState(
  view: ConnectView,
  patch: Partial<ConnectState> = {},
  platform = platformCapabilities("darwin", "arm64"),
): ConnectState {
  return {
    appVersion: APP_VERSION,
    deviceLabel: DEVICE_LABEL,
    locale: "de",
    messages: dictionary("de"),
    view,
    profiles: profileSummaries(store),
    settings: {
      locale: store.settings.locale,
      launchAtLogin: store.settings.launchAtLogin,
      quietHours: store.settings.quietHours,
      notifications: store.settings.notifications,
      shareDiagnostics: store.settings.shareDiagnostics,
    },
    login: { phase: "idle" },
    notice: null,
    signedIn: null,
    onboarding: NO_ONBOARDING,
    update,
    permissions,
    local: LOCAL_UNAVAILABLE,
    platform,
    defaultServer: null,
    report: CLOSED_REPORT,
    ...patch,
  };
}

function opened(state: ConnectState): SignInState {
  return evolve(INITIAL_STATE, { type: "MainStateReceived", state });
}

async function signIn(): Promise<void> {
  const signed = await signInDevice(ctx, browser, descriptor, {
    id: deviceId,
    label: DEVICE_LABEL,
    appVersion: APP_VERSION,
  });
  expect(signed.stateMatches).toBe(true);
  expect(signed.status).toBe(200);
  if (!signed.session) throw new Error("the device session did not parse");
  session = signed.session;
  cookie = signed.cookie;
  const boot = await deviceRequest(ctx, { session, cookie, csrf: "" })(BOOTSTRAP_PATH);
  expect(boot.status).toBe(200);
  csrf = parseCsrfToken(await boot.json()) ?? "";
  expect(csrf).not.toBe("");
  store = upsertProfile(store, ctx.baseUrl, {
    serverVersion: descriptor.version,
    installationId: session.installationId,
    cockpitPath: session.cockpitPath,
  });
}

async function auditEntries(action: string) {
  const res = await journeyFetch(ctx, `/v1/audit-log?action=${action}`);
  expect(res.status).toBe(200);
  const listed = ((await res.json()) as { items: Array<{ id: string; action: string }> }).items
    .filter((item) => item.action === action)
    .map((item) => item.id);
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, action)));
  expect(rows.map((row) => row.id).sort()).toEqual(listed.sort());
  return rows;
}

beforeAll(async () => {
  ctx = await createJourneyCtx("desktop-settled");
  browser = createBrowser(ctx);
  const res = await fetch(`${ctx.baseUrl}${DESCRIPTOR_PATH}`);
  const parsed = parseDescriptor(await res.json());
  if (!parsed?.desktop?.loginSupported) throw new Error("the server offers no desktop sign-in");
  descriptor = parsed;
  deviceId = uuidFrom(ctx.random.bytes(16));
  const fresh = emptyStore();
  store = {
    ...fresh,
    settings: { ...fresh.settings, notificationsAsked: true, diagnosticsAsked: true },
  };
  store = upsertProfile(store, ctx.baseUrl, {}, deviceId);
  store = { ...store, activeProfileId: store.profiles[0]?.id ?? null };
  await signIn();
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("a person who connected earlier works with the desktop app", () => {
  test("the app starts on the connected server without the setup wizard", async () => {
    const attention = await asDevice(ATTENTION_PATH);
    expect(attention.status).toBe(200);

    const state = connectState("connect");
    expect(firstSetup(state)).toBe(false);
    expect(setupComplete(state)).toBe(true);
    const profileId = store.activeProfileId ?? "";
    expect(homeTarget(state)).toEqual({ kind: "cockpit", profileId });

    const view = viewOf(opened(state));
    expect(view?.screen).toMatchObject({
      kind: "server",
      profileId,
      host: hostOf(ctx.baseUrl),
      serverVersion: descriptor.version,
      device: DEVICE_LABEL,
      strip: null,
    });
    expect(view?.frame.dots.visible).toBe(false);
    expect(view?.nav).toBeNull();
    for (const kind of ["welcome", "connect", "consent", "workspace"])
      expect(screenFor(state, INITIAL_FLOW).kind).not.toBe(kind);

    const servers = settingsFor(connectState("settings")).servers;
    expect(servers).toEqual([
      {
        profileId,
        host: hostOf(ctx.baseUrl),
        active: true,
        primary: { label: "profiles.open", command: "open" },
      },
    ]);
    expect(dictionary("de")["profiles.open"]).toBeTruthy();
    expect(dictionary("en")["profiles.open"]).toBeTruthy();
  });

  test("an update check against a missing feed reports the app as up to date", async () => {
    const settings = opened(connectState("settings"));
    const before = settingsFor(connectState("settings")).update;
    expect(before.status.key).toBe("updates.state.idle");
    expect(before.action).toEqual({ label: "tray.checkUpdates", enabled: true, primary: false });
    expect(decide(settings, { type: "RunUpdateAction" }, { requestId: 1 }).effects).toEqual([
      { kind: "updateAction" },
    ]);

    update = reduceUpdate(update, { type: "checking" });
    expect(settingsFor(connectState("settings")).update.action?.enabled).toBe(false);

    const feed = `${ctx.baseUrl}/desktop/updates/latest-mac.yml`;
    const missing = await fetch(feed);
    expect(missing.status).toBe(404);
    const error = Object.assign(
      new Error(
        `Cannot find latest-mac.yml in the latest release artifacts (${feed}): HttpError: ${missing.status}`,
      ),
      { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" },
    );
    const info = classifyUpdateError(error);
    expect(info).toEqual({
      kind: "feed-missing",
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
      status: 404,
      url: feed,
    });
    const event = updateErrorEvent(update, info, error.message);
    expect(event).toEqual({ type: "not-available" });
    update = reduceUpdate(update, event);
    expect(update).toEqual({ phase: "current" });

    const after = settingsFor(connectState("settings")).update;
    expect(after.status).toEqual({
      key: "updates.state.current",
      vars: { version: APP_VERSION },
    });
    expect(after.action).toEqual({ label: "tray.checkUpdates", enabled: true, primary: false });
    expect(dictionary("de")["updates.state.current"]).toContain("{version}");
  });

  test("local capabilities show the device online and name the permission still waiting", () => {
    const state = connectState("local");
    const screen = screenFor(state, INITIAL_FLOW);
    expect(screen).toEqual({
      kind: "local-capabilities",
      device: DEVICE_LABEL,
      online: true,
      supported: true,
      permissions: [
        { key: "accessibility", granted: true },
        { key: "screen", granted: false },
      ],
    });

    const moved = decide(
      opened(connectState("settings")),
      { type: "OpenLocalCapabilities" },
      {
        requestId: 1,
      },
    );
    expect(moved.effects).toEqual([{ kind: "showView", view: "local" }]);

    const permissionsScreen = screenFor(connectState("permissions"), INITIAL_FLOW);
    expect(permissionsScreen).toEqual({
      kind: "permissions",
      setup: {
        supported: true,
        cards: [{ key: "screen", granted: false, restart: true }],
        done: false,
        lost: false,
      },
    });

    const offline = screenFor(
      connectState("local", {
        notice: { kind: "offline", profileId: store.activeProfileId ?? "" },
      }),
      INITIAL_FLOW,
    );
    expect(offline).toMatchObject({ kind: "local-capabilities", online: false });

    permissions = { ...permissions, supported: false };
    const windows = screenFor(
      connectState("local", {}, platformCapabilities("win32", "x64")),
      INITIAL_FLOW,
    );
    expect(windows).toMatchObject({ kind: "local-capabilities", permissions: [] });
    permissions = { ...permissions, supported: true };
  });

  test("a problem report with diagnostics and metadata lands in the workspace intake", async () => {
    const errors = appendError([], {
      at: iso(),
      scope: "feed",
      message: "event stream closed after 3 retries",
    });
    const bundle = buildDiagnostics({
      appVersion: APP_VERSION,
      electronVersion: "39.2.0",
      chromeVersion: "142.0.7444.59",
      platform: "darwin",
      osRelease: "25.1.0",
      arch: "arm64",
      locale: "en",
      packaged: true,
      serverOrigin: ctx.baseUrl,
      serverVersion: descriptor.version,
      connection: "online",
      profileCount: store.profiles.length,
      errors,
      generatedAt: iso(),
      permissions: { accessibility: "granted", screen: "missing" },
    });
    const reportId = uuidFrom(ctx.random.bytes(16));
    const body = reportBody({
      bundle,
      message: "The run list jumps to the top while scrolling.",
      attach: true,
      locale: "en",
      reportId,
      deviceId,
    });
    const target = reportTarget(activeProfile(store), null);
    expect(target).toEqual({ origin: ctx.baseUrl, signedIn: true, deviceId });
    if (!target) throw new Error("no report target");

    let filed: { id: string; intake_item_id: string } | null = null;
    const answer = await deliverReport(target, body, {
      signed: async (signedBody) => {
        expect(signedBody).not.toHaveProperty("device_id");
        const res = await asDevice(FEEDBACK_PATH, {
          method: "POST",
          body: JSON.stringify(signedBody),
        });
        const json = await res.json();
        if (res.ok) filed = json as { id: string; intake_item_id: string };
        return { status: res.status, json, traceId: res.headers.get("x-trace-id") } as ReportAnswer;
      },
      anonymousPath: async () => {
        throw new Error("a signed-in device must not fall back to the anonymous path");
      },
      anonymous: async () => {
        throw new Error("a signed-in device must not fall back to the anonymous path");
      },
    });
    expect(reportOutcome(answer)).toEqual({ ok: true, reference: reportId });
    const stored = filed as { id: string; intake_item_id: string } | null;
    if (!stored) throw new Error("the report was not filed");

    const item = await journeyFetch(ctx, `/v1/intake/items/${stored.intake_item_id}`);
    expect(item.status).toBe(200);
    const entry = (await item.json()) as { category: string; body: string };
    expect(entry.category).toBe("feedback");
    expect(entry.body).toContain("The run list jumps to the top while scrolling.");
    expect(entry.body).toContain("## Diagnostics");
    expect(entry.body).toContain("- Client: desktop");
    expect(entry.body).toContain(`- App version: ${APP_VERSION}`);
    expect(entry.body).toContain("- Platform: darwin 25.1.0 arm64");
    expect(entry.body).toContain(`- Server version: ${descriptor.version}`);
    expect(entry.body).toContain("- Connection: online");
    expect(entry.body).toContain("feed: event stream closed after 3 retries");
    expect(entry.body).toContain("## Attachments");
    expect(entry.body).toContain(DIAGNOSTICS_FILENAME);

    const audits = await auditEntries("feedback.submitted");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({
      kind: "bug",
      report_id: reportId,
      category: "feedback",
      provenance: "signed_in",
      client_kind: "desktop",
      diagnostics: true,
      attachments: 1,
      screenshot: false,
    });
  });

  test("signing out ends the device session and signing in again reuses the installation", async () => {
    const before = session.installationId;
    const out = await asDevice("/v1/identity/logout", { method: "POST", body: "{}" });
    expect(out.status).toBe(204);

    const refused = await asDevice(ATTENTION_PATH);
    const failure = classifyAuthFailure(refused.status, await refused.json().catch(() => null));
    expect(failure).toBe("expired");

    const profileId = store.activeProfileId ?? "";
    store = upsertProfile(store, ctx.baseUrl, { installationId: null, cockpitPath: null });
    const signedOut = connectState("connect", { notice: { kind: "expired", profileId } });
    expect(homeTarget(signedOut)).toEqual({ kind: "wizard" });
    const relogin = viewOf(opened(signedOut));
    expect(relogin?.screen).toMatchObject({ kind: "relogin", origin: ctx.baseUrl });
    expect(relogin?.frame.dots.visible).toBe(false);
    expect(settingsFor(connectState("settings")).servers[0]?.primary).toEqual({
      label: "profiles.signIn",
      command: "sign-in",
    });

    const revoked = await auditEntries("session.revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.reason).toBe("user_logout");
    expect(await auditEntries("user.logged_out")).toHaveLength(1);

    await signIn();
    expect(session.installationId).toBe(before);
    expect((await asDevice(ATTENTION_PATH)).status).toBe(200);
    const back = viewOf(opened(connectState("connect")));
    expect(back?.screen).toMatchObject({ kind: "server", profileId });
    expect(homeTarget(connectState("connect"))).toEqual({ kind: "cockpit", profileId });
    expect(await auditEntries("desktop_login.completed")).toHaveLength(2);

    const list = await browser.request("/v1/cockpit/installations", {
      headers: { accept: "application/json" },
    });
    const installations = (await list.json()) as { installations: Array<{ id: string }> };
    expect(installations.installations.filter((entry) => entry.id === before)).toHaveLength(1);
  });
});
