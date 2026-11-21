import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { dictionary, type Locale } from "../../shared/i18n.ts";
import type { CheckResult, CheckStatus, ConnectState } from "../../shared/ipc.ts";
import { completeStep, NO_ONBOARDING, startOnboarding } from "../../shared/onboarding.ts";
import type { SignInStore } from "../adapter/index.ts";
import { type Event, evolveAll, INITIAL_STATE, type SignInState, viewOf } from "../domain/index.ts";
import { desktopRunner } from "../lib/test-runner.ts";
import { SignInWindow } from "./sign-in-window.tsx";

const ORIGIN = "https://subkit.example.com";

function main(patch: Partial<ConnectState> = {}, locale: Locale = "en"): ConnectState {
  return {
    appVersion: "11.2.0",
    deviceLabel: "MacBook-Anna",
    locale,
    messages: dictionary(locale),
    view: "connect",
    profiles: [
      {
        id: "p1",
        label: "work",
        serverOrigin: "https://work.example.com",
        signedIn: false,
        active: true,
      },
    ],
    settings: {
      locale: "system",
      launchAtLogin: false,
      quietHours: { enabled: false, start: "22:00", end: "07:00" },
      notifications: true,
      shareDiagnostics: false,
    },
    login: { phase: "idle" },
    notice: null,
    signedIn: null,
    onboarding: NO_ONBOARDING,
    update: { phase: "idle" },
    ...patch,
  };
}

function result(status: CheckStatus, extra: Partial<CheckResult> = {}): CheckResult {
  return {
    status,
    origin: ORIGIN,
    serverVersion: "11.2.0",
    minAppVersion: null,
    minServerVersion: "11.2.0",
    ...extra,
  };
}

function state(patch: Partial<ConnectState> = {}, events: Event[] = [], locale: Locale = "en") {
  return evolveAll(INITIAL_STATE, [
    { type: "MainStateReceived", state: main(patch, locale) },
    ...events,
  ]);
}

function checked(status: CheckStatus, extra: Partial<CheckResult> = {}): Event[] {
  return [
    { type: "VersionCheckStarted", address: "subkit.example.com", requestId: 1 },
    { type: "VersionChecked", requestId: 1, result: result(status, extra) },
  ];
}

function storeAt(current: SignInState): SignInStore {
  const view = viewOf(current);
  return {
    getState: () => current,
    getView: () => view,
    dispatch: () => {},
    subscribe: () => () => {},
  };
}

function render(current: SignInState): string {
  return renderToStaticMarkup(<SignInWindow store={storeAt(current)} />);
}

const count = (html: string, text: string) => html.split(text).length - 1;
const tagOf = (html: string, testId: string) =>
  html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";

describe.skipIf(!desktopRunner)("sign-in window page", () => {
  test("renders nothing before the main process answered", () => {
    expect(render(INITIAL_STATE)).toBe("");
  });

  test("the connect step offers known servers and localhost as examples, and the app version", () => {
    const html = render(state());
    expect(html).toContain("Connect server");
    expect(html).toContain("work.example.com");
    expect(html).toContain("localhost:3000");
    expect(html).toContain("SubKit Desktop 11.2.0");
    expect(html).toContain("border-dashed");
  });

  test("an unreachable server is the error card with one retry and the example", () => {
    const html = render(state({}, checked("unreachable")));
    expect(html).toContain('data-slot="error-notice"');
    expect(count(html, "Server not reachable")).toBe(1);
    expect(count(html, "No answer came from this address.")).toBe(1);
    expect(count(html, "Try again")).toBe(1);
    expect(count(html, "Use the example")).toBe(1);
    expect(html).toMatch(
      /data-testid="step-next"[^>]*disabled|disabled[^>]*data-testid="step-next"/,
    );
  });

  test("a server that is too old is a card with ask-the-admin and try again", () => {
    const html = render(state({}, checked("server-too-old", { serverVersion: "10.4.0" })));
    expect(html).toContain("Version 10.4.0 isn’t supported");
    expect(html).toContain("This app needs 11.2.0 or later. Nothing was changed.");
    expect(html).toContain('data-testid="connect-ask-admin"');
    expect(html).toContain('data-testid="connection-retry"');
  });

  test("device registered: a heading, a lead, server and device once each, a connected pill", () => {
    const html = render(
      state({ signedIn: { profileId: "p1", origin: ORIGIN, serverVersion: "11.2.0" } }, [], "de"),
    );
    expect(count(html, "Gerät registriert")).toBe(1);
    expect(html).toContain("Dieses Gerät ist jetzt registriert.");
    expect(count(html, "subkit.example.com · 11.2.0")).toBe(1);
    expect(count(html, "MacBook-Anna")).toBe(1);
    expect(count(html, ">Verbunden<")).toBe(1);
    expect(html).toContain("SubKit öffnen");
  });

  test("a canceled sign-in is a one-line strip without technical detail", () => {
    const html = render(
      state({ login: { phase: "failed", origin: ORIGIN, reason: "cancelled" } }, [
        ...checked("compatible"),
        { type: "SignInTargetChosen", origin: ORIGIN, serverVersion: "11.2.0" },
      ]),
    );
    expect(html).toContain("Sign-in canceled");
    expect(html).not.toContain("aria-expanded=");
    expect(html).not.toContain("technical-toggle");
  });

  test("a rejected sign-in keeps its code collapsed", () => {
    const html = render(
      state({ login: { phase: "failed", origin: ORIGIN, reason: "rejected" } }, [
        { type: "SignInTargetChosen", origin: ORIGIN, serverVersion: "11.2.0" },
      ]),
    );
    expect(html).toContain("The server declined");
    expect(html).toContain('aria-expanded="false"');
  });

  test("an expired session asks to sign in again and hides the step footer", () => {
    const html = render(state({ notice: { kind: "expired", profileId: "p1" } }));
    expect(html).toContain("Session expired");
    expect(html).toContain("Connect another server");
    expect(html).not.toContain("<footer");
  });

  test("settings list your servers and the general switches", () => {
    const html = render(state({ view: "settings" }, [], "de"));
    expect(html).toContain("Deine Server");
    expect(html).toContain("work.example.com");
    expect(html).toContain("Ruhezeiten");
    expect(html).toContain('role="switch"');
  });
});

describe("first run after sign-in", () => {
  const signedIn = { profileId: "p1", origin: ORIGIN, serverVersion: "11.2.0" };
  const workspaces = [
    { tenantId: "t1", name: "Bild Consulting", role: "admin", owner: true },
    { tenantId: "t2", name: "Harmoniqs", role: "partner", owner: false },
  ];
  const fresh = startOnboarding(workspaces, {
    notificationsAsked: false,
    diagnosticsAsked: false,
  });

  test("the workspace choice lists every workspace with its role, next waits for a choice", () => {
    const html = render(state({ signedIn, onboarding: fresh }, [], "de"));
    expect(html).toContain("Bild Consulting · Administrator");
    expect(html).toContain("Harmoniqs · partner");
    expect(html).toContain("Du hast Zugriff auf 2 Arbeitsbereiche.");
    expect(html).toMatch(
      /data-testid="first-run-workspace-next"[^>]*disabled|disabled[^>]*data-testid="first-run-workspace-next"/,
    );
  });

  test("after a failed switch the window offers to stay in the current workspace", () => {
    const html = render(state({ signedIn, onboarding: { ...fresh, failed: true } }, [], "de"));
    expect(html).toContain("Der Wechsel hat nicht geklappt. Versuch es noch einmal.");
    expect(html).toContain("Im aktuellen Arbeitsbereich bleiben");
  });

  test("notifications offer allow and not now", () => {
    const onboarding = completeStep({ ...fresh, chosen: "t1" }, "workspace");
    const html = render(state({ signedIn, onboarding }, [], "de"));
    expect(html).toContain("Benachrichtigungen erlauben");
    expect(html).toContain(">Erlauben<");
    expect(html).toContain(">Jetzt nicht<");
  });

  test("diagnostics use the same choice as notifications and wait for an answer", () => {
    const onboarding = completeStep(completeStep(fresh, "workspace"), "notifications");
    const html = render(state({ signedIn, onboarding }, [], "de"));
    expect(html).toContain("Diagnosedaten");
    expect(tagOf(html, "first-run-diagnostics-off")).toContain('aria-checked="false"');
    expect(tagOf(html, "first-run-diagnostics-on")).toContain('aria-checked="false"');
    expect(tagOf(html, "first-run-diagnostics-next")).toContain('disabled=""');
  });

  test("allowed notifications show the pressed choice and open Next", () => {
    const onboarding = completeStep({ ...fresh, chosen: "t1" }, "workspace");
    const html = render(
      state(
        { signedIn, onboarding },
        [{ type: "ConsentChosen", topic: "notifications", give: true }],
        "de",
      ),
    );
    expect(tagOf(html, "first-run-notifications-on")).toContain('aria-checked="true"');
    expect(tagOf(html, "first-run-notifications-next")).not.toContain('disabled=""');
    expect(tagOf(html, "first-run-notifications-next")).toContain("first-run-notifications-next");
  });

  test("while the workspaces load, the sign-in step says you are signed in", () => {
    const html = render(
      state({ signedIn, onboarding: { ...NO_ONBOARDING, loading: true } }, [], "de"),
    );
    expect(html).toContain('data-testid="signin-done"');
    expect(count(html, "Angemeldet")).toBe(1);
    expect(html).not.toContain('data-testid="signin-open"');
  });
});

describe.skipIf(!desktopRunner)("welcome and invitation", () => {
  test("a first start shows four promises, Get started and the invitation link", () => {
    const html = render(state({ profiles: [] }, [], "de"));
    expect(html).toContain("Willkommen bei SubKit Desktop");
    expect(count(html, "<li")).toBe(4);
    expect(html).toContain('data-testid="welcome-start"');
    expect(html).toContain('data-testid="welcome-invite" aria-expanded="false"');
    expect(html).not.toContain("welcome-invite-link");
  });

  test("the opened invitation field has a label, a hint and its button", () => {
    const html = render(state({ profiles: [] }, [{ type: "InviteToggled" }], "de"));
    expect(html).toContain("Einladungslink</label>");
    expect(html).toContain("Füge den Link aus deiner Einladungs-Mail ein.");
    expect(html).toContain('data-testid="welcome-invite-open"');
  });

  test("a valid invitation names inviter, workspace and expiry and offers to join", () => {
    const link = "https://subkit.example.com/cockpit/invite#wf_invite_abcdefgh12345678";
    const html = render(
      state(
        { profiles: [] },
        [
          { type: "InviteToggled" },
          { type: "InviteEdited", link },
          { type: "InviteCheckStarted", requestId: 1 },
          {
            type: "InviteChecked",
            requestId: 1,
            link,
            check: {
              kind: "preview",
              preview: {
                status: "valid",
                origin: ORIGIN,
                workspace: "Harmoniqs",
                invitedBy: "Anna Schmidt",
                emailHint: "m•••@example.com",
                expiresAt: "2026-11-27T12:00:00.000Z",
              },
            },
          },
        ],
        "de",
      ),
    );
    expect(html).toContain("Du bist eingeladen");
    expect(html).toContain("Anna Schmidt hat dich in den Arbeitsbereich „Harmoniqs“ eingeladen.");
    expect(html).toContain("Einladung für m•••@example.com · gültig bis 27.11.2026");
    expect(html).toContain("Im Browser beitreten");
  });
});
