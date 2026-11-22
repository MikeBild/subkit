import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { dictionary, type Locale } from "../../shared/i18n.ts";
import { type ConnectState, LOCAL_UNAVAILABLE, type LocalView } from "../../shared/ipc.ts";
import { NO_ONBOARDING } from "../../shared/onboarding.ts";
import { platformCapabilities } from "../../shared/platform-capabilities.ts";
import { createMockLocalCapabilities, type SignInStore } from "../adapter/index.ts";
import { type Event, evolveAll, INITIAL_STATE, type SignInState, viewOf } from "../domain/index.ts";
import { desktopRunner } from "../lib/test-runner.ts";
import { SignInWindow } from "./sign-in-window.tsx";

const FOLDER = "/Users/anna/Library/Application Support/SubKit";

function main(
  local: Partial<LocalView>,
  locale: Locale,
  view: "connect" | "settings",
): ConnectState {
  return {
    appVersion: "11.2.0",
    deviceLabel: "MacBook-Anna",
    locale,
    messages: dictionary(locale),
    view,
    profiles: [],
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
    local: { ...LOCAL_UNAVAILABLE, available: true, folder: FOLDER, ...local },
    platform: platformCapabilities("darwin", "arm64"),
  };
}

function render(
  local: Partial<LocalView>,
  events: Event[] = [],
  locale: Locale = "en",
  view: "connect" | "settings" = "connect",
): string {
  const state: SignInState = evolveAll(INITIAL_STATE, [
    { type: "MainStateReceived", state: main(local, locale, view) },
    ...events,
  ]);
  const current = viewOf(state);
  const store: SignInStore = {
    getState: () => state,
    getView: () => current,
    dispatch: () => {},
    subscribe: () => () => {},
  };
  return renderToStaticMarkup(<SignInWindow store={store} local={createMockLocalCapabilities()} />);
}

const setup: Event[] = [{ type: "LocalSetupOpened" }];
const at = (step: number): Event[] => [...setup, { type: "LocalStepChanged", step }];

describe.skipIf(!desktopRunner)("local mode in the connect window", () => {
  test("the connect step offers a server or only this Mac", () => {
    const html = render({}, [{ type: "ConnectStarted", path: "server" }], "de");
    expect(html).toContain("Mit einem Server verbinden");
    expect(html).toContain("Nur auf diesem Mac");
    expect(render({ available: false })).not.toContain("connect-choice-local");
  });

  test("the folder step shows the folder and refuses a synced one", () => {
    expect(render({}, setup)).toContain(FOLDER);
    const refused = render({ folderRefusal: "cloud_synced_folder" }, setup);
    expect(refused).toContain("The database can’t run here.");
    expect(refused).toMatch(
      /data-testid="local-next"[^>]*disabled|disabled[^>]*data-testid="local-next"/,
    );
  });

  test("the you step asks for a name only", () => {
    const html = render({}, at(1));
    expect(html).toContain('data-testid="local-name"');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('type="email"');
  });

  test("the AI step offers a provider key or a local model server", () => {
    const html = render({}, at(2));
    expect(html).toContain("Provider key");
    expect(html).toContain("Local model server");
    expect(html).toContain('type="password"');
  });

  test("the setting-up step shows the real phases and a remedy for each error", () => {
    const html = render(
      { working: true, progress: { database: true, engine: false, workspace: false } },
      at(3),
    );
    expect(html).toContain("Database");
    expect(html).toContain("Engine");
    expect(html).toContain("Workspace");
    expect(html.match(/<span aria-hidden="true" class="size-1[^"]*"><\/span>Done</g)).toHaveLength(
      1,
    );
    for (const [error, title, remedy] of [
      ["port", "Port is busy", "Use another port"],
      ["disk", "Not enough disk space", "Try again"],
      ["permission", "No access to the folder", "Choose another folder…"],
    ] as const) {
      const failed = render({ error }, at(3));
      expect(failed).toContain(title);
      expect(failed).toContain(remedy);
    }
  });

  test("a configured workspace that starts shows the phases without a way back", () => {
    const html = render({ configured: true, attention: true, working: true }, [], "de");
    expect(html).toContain("Lokaler Arbeitsbereich startet");
    expect(html).toMatch(/data-testid="local-back"[^>]*aria-hidden="true"/);
  });

  test("settings list the backups and offer the move to a server", () => {
    const html = render(
      {
        configured: true,
        progress: { database: true, engine: true, workspace: true },
        sizeBytes: 24_000_000,
        backups: [
          {
            name: "2026-11-21T08-00-00Z-update",
            at: Date.parse("2026-11-21T08:00:00Z"),
            reason: "update",
            automatic: true,
            sizeBytes: 3_000_000,
          },
        ],
      },
      [],
      "de",
      "settings",
    );
    expect(html).toContain("Lokaler Arbeitsbereich");
    expect(html).toContain("24 MB");
    expect(html).toContain("Automatisch vor Update");
    expect(html).toContain("Sicherung erstellen");
    expect(html).toContain("Auf einen Server umziehen");
    expect(html).toContain('data-testid="local-restore-2026-11-21T08-00-00Z-update"');
  });

  test("settings without a local workspace show no local section", () => {
    expect(render({}, [], "en", "settings")).not.toContain("Local workspace");
  });

  test("the AI step can be skipped and the last step offers opening at login", () => {
    expect(render({}, at(2), "de")).toContain("Später einrichten");
    const last = render(
      { progress: { database: true, engine: true, workspace: true } },
      at(3),
      "de",
    );
    expect(last).toContain("Bei der Anmeldung öffnen");
    expect(last).toContain('data-testid="local-open-at-login"');
  });

  test("a model without tool calls is named in setup and settings", () => {
    expect(render({ modelTools: false }, at(3), "de")).toContain(
      "Modell kann keine Werkzeuge aufrufen",
    );
    const settings = render(
      { configured: true, modelTools: false, aiConfigured: true },
      [],
      "de",
      "settings",
    );
    expect(settings).toContain("Modell kann keine Werkzeuge aufrufen");
    expect(render({ configured: true, aiConfigured: false }, [], "de", "settings")).toContain(
      "KI-Zugang fehlt",
    );
  });

  test("a moved workspace is read-only with the server sign-in as remedy", () => {
    const html = render(
      { configured: true, moved: { server: "https://subkit.example.com", bundle: "/x/b.zip" } },
      [],
      "de",
      "settings",
    );
    expect(html).toContain("Arbeitsbereich ist umgezogen");
    expect(html).toContain("https://subkit.example.com");
    expect(html).toContain("Beim Server anmelden");
    expect(html.match(/class="(?:[^"]* )?hidden(?: [^"]*)?"/g)).toHaveLength(2);
    expect(html).toContain('data-testid="local-remove-all"');
  });
});
