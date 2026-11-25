import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { dictionary, type Locale } from "../../shared/i18n.ts";
import {
  type CheckResult,
  type CheckStatus,
  type ConnectState,
  LOCAL_UNAVAILABLE,
} from "../../shared/ipc.ts";
import { completeStep, NO_ONBOARDING, startOnboarding } from "../../shared/onboarding.ts";
import { platformCapabilities } from "../../shared/platform-capabilities.ts";
import { CLOSED_REPORT } from "../../shared/problem-report.ts";
import { createMockLocalCapabilities, type SignInStore } from "../adapter/index.ts";
import { type Event, evolveAll, INITIAL_STATE, type SignInState, viewOf } from "../domain/index.ts";
import { desktopRunner } from "../lib/test-runner.ts";
import { SignInWindow } from "./sign-in-window.tsx";

const ORIGIN = "https://subkit.example.com";
const CLOUD = "https://subkit-cloud.example";

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
    permissions: {
      supported: true,
      permissions: { accessibility: false, screen: false, restartPending: false },
      lost: [],
    },
    local: LOCAL_UNAVAILABLE,
    platform: platformCapabilities("darwin", "arm64"),
    defaultServer: null,
    report: CLOSED_REPORT,
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
    copyText: () => Promise.resolve(true),
    subscribe: () => () => {},
  };
}

function render(current: SignInState): string {
  return renderToStaticMarkup(
    <SignInWindow store={storeAt(current)} local={createMockLocalCapabilities()} />,
  );
}

const count = (html: string, text: string) => html.split(text).length - 1;
const tagOf = (html: string, testId: string) =>
  html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";

describe.skipIf(!desktopRunner)("sign-in window page", () => {
  test("renders nothing before the main process answered", () => {
    expect(render(INITIAL_STATE)).toBe("");
  });

  test("the connect step prefills SubKit Cloud, hints at an own server and the app version", () => {
    const html = render(
      state({
        defaultServer: CLOUD,
        profiles: [
          ...main().profiles,
          {
            id: "p2",
            label: "local",
            serverOrigin: "http://127.0.0.1:3480",
            signedIn: false,
            active: false,
          },
        ],
      }),
    );
    expect(html).toContain("Connect server");
    expect(html).toContain(`value="${CLOUD}"`);
    expect(html).toContain(
      "Your own server? Enter its address, e.g. https://subkit.your-company.com",
    );
    expect(html).toContain("work.example.com");
    expect(html).not.toContain("127.0.0.1:3480");
    expect(html).not.toContain("localhost:3000");
    expect(html).toContain("SubKit Desktop 11.2.0");
    expect(html).toContain("border-dashed");
  });

  test("the German connect step names an own server in German", () => {
    const html = render(state({ defaultServer: CLOUD }, [], "de"));
    expect(html).toContain(dictionary("de")["connect.ownServer"].split("{example}")[0] ?? "");
    expect(html).toContain(dictionary("de")["connect.examples"]);
  });

  test("an unreachable server is the error card with one retry and SubKit Cloud", () => {
    const html = render(state({ defaultServer: CLOUD }, checked("unreachable")));
    expect(html).toContain('data-slot="error-notice"');
    expect(count(html, "Server not reachable")).toBe(1);
    expect(count(html, "No answer came from this address.")).toBe(1);
    expect(count(html, "Try again")).toBe(1);
    expect(count(html, "Use SubKit Cloud")).toBe(1);
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
  test("the permission setup shows both cards, a restart once granted and a lost permission", () => {
    const html = render(
      state(
        {
          view: "permissions",
          permissions: {
            supported: true,
            permissions: { accessibility: false, screen: true, restartPending: true },
            lost: ["accessibility"],
          },
        },
        [],
        "de",
      ),
    );
    expect(html).toContain("Damit SubKit Apps bedienen kann");
    expect(html).toContain('data-testid="permission-accessibility-open"');
    expect(html).toContain('data-testid="permission-accessibility-check"');
    expect(html).toContain('data-testid="permission-screen-restart"');
    expect(html).toContain("SubKit neu starten");
    expect(html).toContain('data-testid="permissions-lost"');
    expect(html).toContain("Berechtigung fehlt: Bedienungshilfen");
    expect(html).toMatch(/data-testid="permissions-next"[^>]*disabled/);
    expect(html).toContain('data-testid="permissions-skip"');
    expect(html).toContain('aria-label="Schritt 1 von 6" aria-hidden="true"');
  });

  test("settings lead to the local capabilities of this Mac", () => {
    const html = render(state({ view: "settings" }, [], "de"));
    expect(html).toContain("Lokale Fähigkeiten");
    expect(html).toContain('data-testid="settings-local-open"');
  });

  test("local capabilities show the switch, the device and four tabs while they load", () => {
    const html = render(state({ view: "local" }, [], "de"));
    expect(html).toContain("Chat und Aufgaben dürfen diesen Mac nutzen");
    expect(html).toContain("MacBook-Anna");
    for (const label of ["Ordner (0)", "Websites (0)", "Apps (0)", "Tabu für SubKit (0)"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('data-testid="local-choose-folder"');
    expect(html).not.toContain("Deine Server");
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
  test("a first start shows four promises, Get started, Create and the invitation link", () => {
    const html = render(state({ profiles: [] }, [], "de"));
    expect(html).toContain("Willkommen bei SubKit Desktop");
    expect(count(html, "<li")).toBe(4);
    expect(html).toContain('data-testid="welcome-start"');
    expect(html).toContain('data-testid="welcome-create"');
    expect(html).toContain("Neuen Arbeitsbereich anlegen");
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
    expect(html).toContain("Beitreten und anmelden");
  });

  const opened = {
    ...CLOSED_REPORT,
    host: "subkit-cloud.example",
    preview: [
      { label: "report.fact.app" as const, value: "12.1.5" },
      { label: "report.fact.log" as const, value: "200" },
    ],
  };

  test("the report screen has a description, attached diagnostics with a preview and Send", () => {
    const html = render(state({ view: "report", report: opened }, [], "de"));
    expect(html).toContain(dictionary("de")["report.title"]);
    expect(html).toContain("Die Meldung geht an subkit-cloud.example.");
    expect(html).toContain("Was ist passiert?");
    expect(html).toContain('maxLength="5000"');
    expect(html).toMatch(
      /data-testid="report-attach"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-testid="report-attach"/,
    );
    expect(html).toContain('data-testid="report-preview"');
    expect(html).toContain("App-Version");
    expect(html).toContain("12.1.5");
    expect(tagOf(html, "report-send")).toContain("report-send");
    expect(html).toContain(`>${dictionary("de")["report.send"]}<`);
    expect(html).toContain(dictionary("de")["report.copy"]);
    expect(html).toContain("Als Datei speichern …");
    expect(html).not.toContain('data-testid="step-next"');
  });

  test("an unchecked box hides the preview", () => {
    const html = render(state({ view: "report", report: { ...opened, attachDefault: false } }));
    expect(html).toMatch(
      /data-testid="report-attach"[^>]*aria-checked="false"|aria-checked="false"[^>]*data-testid="report-attach"/,
    );
    expect(html).not.toContain('data-testid="report-preview"');
  });

  test("a sent report shows the report id and only Close", () => {
    const report = { ...opened, phase: "sent" as const, reference: "4b0c-report" };
    const html = render(state({ view: "report", report }));
    expect(html).toContain("Thanks, your report arrived.");
    expect(html).toContain("Report ID:");
    expect(html).toContain("4b0c-report");
    expect(html).not.toContain('data-testid="report-send"');
    expect(html).not.toContain('data-testid="report-message"');
    expect(html).toContain(">Close<");
  });

  test("a failed report explains why, names the trace id and keeps copy and save", () => {
    const report = {
      ...opened,
      phase: "failed" as const,
      failure: "unavailable" as const,
      reference: "trace-77",
    };
    const html = render(state({ view: "report", report }));
    expect(html).toContain("This server takes no reports without sign-in.");
    expect(html).toContain("Sign in and try again");
    expect(html).toContain("Trace ID:");
    expect(html).toContain("trace-77");
    expect(html).toContain(">Send again<");
    expect(html).toContain("Copy diagnostics");
    expect(html).toContain("Save as file…");
  });

  test("without any server the screen offers only copy and save with a clear message", () => {
    const report = { ...CLOSED_REPORT, phase: "failed" as const, failure: "no_server" as const };
    const html = render(state({ view: "report", report }));
    expect(html).toContain("No server connected yet.");
    expect(html).not.toContain('data-testid="report-send"');
    expect(html).toContain("Copy diagnostics");
  });
});

describe.skipIf(!desktopRunner)("connected state on the server step", () => {
  const CONNECTED = {
    defaultServer: CLOUD,
    profiles: [
      {
        id: "p1",
        label: "subkit-cloud.example",
        serverOrigin: CLOUD,
        signedIn: true,
        active: true,
        serverVersion: "12.1.5",
      },
    ],
  };

  for (const locale of ["de", "en"] as const) {
    test(`a signed-in server is the primary state, the form stays folded (${locale})`, () => {
      const html = render(state(CONNECTED, [], locale));
      const copy = dictionary(locale);
      expect(html).toContain('data-testid="server-overview"');
      expect(html).toContain("subkit-cloud.example");
      expect(html).toContain(copy["signin.connected"]);
      expect(html).toContain(copy["chip.version"].replace("{version}", "12.1.5"));
      expect(html).toContain(copy["relogin.other"]);
      expect(html).toContain(copy["signin.enter"]);
      expect(html).not.toContain('data-testid="connect-address"');
      expect(html).not.toContain('data-testid="connect-check"');
      expect(html).not.toContain('data-testid="connect-own-server"');
      expect(html).not.toContain('data-testid="connect-choice-server"');
      expect(viewOf(state(CONNECTED, [], locale))?.frame.dots.visible).toBe(false);
    });
  }

  test("connect another server unfolds the form with a way back", () => {
    const html = render(state(CONNECTED, [{ type: "OtherServerOpened" }], "de"));
    expect(html).toContain('data-testid="connect-address"');
    expect(html).not.toContain('data-testid="server-overview"');
    expect(html).not.toMatch(/data-testid="step-back"[^>]*aria-hidden="true"/);
  });

  test("offline keeps the server on top and offers to try again", () => {
    const html = render(
      state({ ...CONNECTED, notice: { kind: "offline", profileId: "p1" } }, [], "de"),
    );
    expect(html).toContain('data-testid="server-overview"');
    expect(html).toContain('data-testid="server-notice-action"');
    expect(html).not.toContain(dictionary("de")["signin.connected"]);
  });

  test("signing in to the server you are already signed in to shows the signed-in state", () => {
    const html = render(
      state(CONNECTED, [
        { type: "OtherServerOpened" },
        { type: "SignInTargetChosen", origin: CLOUD, serverVersion: "12.1.5" },
      ]),
    );
    expect(html).toContain('data-testid="signin-done"');
    expect(html).not.toContain('data-testid="signin-open"');
    expect(html).toContain("Open SubKit");
    expect(html).not.toMatch(/data-testid="step-next"[^>]*disabled/);
  });
});

describe.skipIf(!desktopRunner)("local capabilities status at a glance", () => {
  const SIGNED_IN_PROFILE = {
    id: "p1",
    label: "work",
    serverOrigin: "https://work.example.com",
    signedIn: true,
    active: true,
  };
  const PARTIAL = {
    view: "local" as const,
    profiles: [SIGNED_IN_PROFILE],
    permissions: {
      supported: true,
      permissions: { accessibility: true, screen: false, restartPending: false },
      lost: [],
    },
  };

  test("the device is green while online and each permission shows its state", () => {
    const html = render(state(PARTIAL, [], "de"));
    expect(html).toMatch(/data-testid="local-status-device" data-online="true"/);
    expect(html).toMatch(/data-testid="local-status-accessibility" data-granted="true"/);
    expect(html).toMatch(/data-testid="local-status-screen" data-granted="false"/);
    const de = dictionary("de");
    expect(html).toContain(de["permissions.name.screen"]);
    expect(html).toContain(de["permissions.missing"]);
    expect(html).toContain(de["permissions.granted"]);
  });

  test("the device turns grey while the server is offline", () => {
    const html = render(
      state({ ...PARTIAL, notice: { kind: "offline", profileId: "p1" } }, [], "de"),
    );
    expect(html).toMatch(/data-testid="local-status-device" data-online="false"/);
  });

  test("the long explanation moved into the info button, not into the row", () => {
    const html = render(state(PARTIAL, [], "de"));
    const explain = dictionary("de")["local.explain"];
    expect(html).toContain(`aria-label="${explain}"`);
    expect(count(html, explain)).toBe(1);
  });

  test("without permission support only the device is shown", () => {
    const html = render(
      state({ ...PARTIAL, permissions: { ...PARTIAL.permissions, supported: false } }, [], "en"),
    );
    expect(html).toContain('data-testid="local-status-device"');
    expect(html).not.toContain('data-testid="local-status-screen"');
  });
});
