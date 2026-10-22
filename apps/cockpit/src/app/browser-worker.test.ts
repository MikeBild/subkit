import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../public/browser-worker.js", import.meta.url), "utf8");
const origin = "https://app.example.test";
const scope = `${origin}/cockpit/`;

interface WindowClientFixture {
  url: string;
  focused: boolean;
  visibilityState: "visible" | "hidden";
  messages: unknown[];
  focus(): Promise<WindowClientFixture>;
  postMessage(message: unknown): void;
}

function windowClient(
  url: string,
  visibilityState: "visible" | "hidden" = "hidden",
): WindowClientFixture {
  const client: WindowClientFixture = {
    url,
    focused: false,
    visibilityState,
    messages: [],
    postMessage: (message) => client.messages.push(message),
    focus: async () => {
      client.focused = true;
      return client;
    },
  };
  return client;
}

interface WorkerOptions {
  language?: string;
  languages?: string[];
  cookieStore?: { get(name: string): Promise<{ value: string } | null> };
}

function worker(windows: WindowClientFixture[] = [], options: WorkerOptions | string = {}) {
  const {
    language = "en-US",
    languages,
    cookieStore,
  } = typeof options === "string" ? { language: options } : options;
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const notifications: unknown[] = [];
  const opened: unknown[] = [];
  const matchAllOptions: unknown[] = [];
  const calls: string[] = [];
  const timeline: string[] = [];
  vm.runInNewContext(source, {
    URL,
    setTimeout: (resolve: () => void, delay: number) => {
      timeline.push(`wait ${delay}`);
      resolve();
    },
    self: {
      location: { origin },
      navigator: { language, languages: languages ?? [language] },
      cookieStore,
      registration: {
        scope,
        showNotification: async (...args: unknown[]) => {
          notifications.push(args);
          timeline.push("notify");
        },
      },
      skipWaiting: () => calls.push("skipWaiting"),
      clients: {
        claim: () => calls.push("claim"),
        openWindow: async (url: unknown) => {
          opened.push(url);
          return null;
        },
        matchAll: async (options: unknown) => {
          matchAllOptions.push(options);
          return windows;
        },
      },
      addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) =>
        handlers.set(name, handler),
    },
  });
  return {
    handlers,
    notifications,
    opened,
    matchAllOptions,
    calls,
    timeline,
    async dispatch(name: string, properties: Record<string, unknown> = {}) {
      let completion: Promise<unknown> = Promise.resolve();
      handlers.get(name)?.({
        ...properties,
        waitUntil: (value: Promise<unknown>) => {
          completion = Promise.resolve(value);
        },
      });
      await completion;
    },
  };
}

describe("browser tab push worker", () => {
  test("listens only for install, push and notification clicks", async () => {
    const app = worker();
    expect([...app.handlers.keys()].sort()).toEqual(["install", "notificationclick", "push"]);
    await app.dispatch("install");
    expect(app.calls).toEqual(["skipWaiting"]);
    expect(source).not.toMatch(/caches\.|indexedDB|localStorage|clients\.claim|fetch\(/);
  });

  test("shows only a neutral notification while no Cockpit window is visible", async () => {
    const hidden = windowClient(`${origin}/cockpit/flows`);
    const foreign = windowClient("https://other.example.test/cockpit/", "visible");
    const lookalike = windowClient(`${origin}/cockpitx`, "visible");
    const app = worker([hidden, foreign, lookalike]);
    await app.dispatch("push", {
      data: { text: () => "secret tenant workflow approval" },
    });
    expect(app.notifications).toEqual([
      [
        "SubKit",
        {
          body: "New entries need you",
          icon: "/cockpit/app-icon-192.png",
          tag: "/cockpit/",
          renotify: true,
        },
      ],
    ]);
    expect([hidden, foreign, lookalike].flatMap((client) => client.messages)).toEqual([]);
    expect(app.matchAllOptions).toEqual([{ type: "window", includeUncontrolled: true }]);
  });

  test("a visible Cockpit tab gets an in-app hint instead of a notification", async () => {
    const tab = windowClient(`${origin}/cockpit/flows`, "visible");
    const app = worker([tab]);
    await app.dispatch("push", {
      data: { text: () => "secret tenant workflow approval" },
    });
    expect(app.notifications).toEqual([]);
    expect(tab.messages).toEqual([{ type: "attention" }]);
    expect(app.matchAllOptions).toEqual([{ type: "window", includeUncontrolled: true }]);
  });

  test("a visible installed app window of any workspace leaves the tab push to the OS", async () => {
    const installed = windowClient(
      `${origin}/cockpit/i/11111111-1111-4111-8111-111111111111/`,
      "visible",
    );
    const hidden = windowClient(`${origin}/cockpit/`);
    const app = worker([installed, hidden]);
    await app.dispatch("push", {});
    expect(app.notifications).toHaveLength(1);
    expect(installed.messages).toEqual([]);
    expect(hidden.messages).toEqual([]);
  });

  test("a German browser gets the German notification text and no payload content", async () => {
    const app = worker([], "de-DE");
    await app.dispatch("push", {
      data: { text: () => "secret tenant workflow approval" },
    });
    expect(JSON.stringify(app.notifications)).not.toContain("secret");
    expect(app.notifications).toEqual([
      [
        "SubKit",
        {
          body: "Neue Einträge brauchen dich",
          icon: "/cockpit/app-icon-192.png",
          tag: "/cockpit/",
          renotify: true,
        },
      ],
    ]);
  });

  test("the chosen Cockpit language wins over the browser language", async () => {
    const asked: string[] = [];
    const app = worker([], {
      language: "en-US",
      cookieStore: {
        get: async (name) => {
          asked.push(name);
          return { value: "de" };
        },
      },
    });
    await app.dispatch("push", {});
    expect(asked).toEqual(["sk_locale"]);
    expect(app.notifications).toMatchObject([["SubKit", { body: "Neue Einträge brauchen dich" }]]);
  });

  test("without a chosen language it follows the first supported browser language", async () => {
    const unreadable = worker([], {
      languages: ["fr-FR", "de-CH"],
      cookieStore: {
        get: async () => {
          throw new Error("blocked");
        },
      },
    });
    await unreadable.dispatch("push", {});
    expect(unreadable.notifications).toMatchObject([
      ["SubKit", { body: "Neue Einträge brauchen dich" }],
    ]);
    const unknown = worker([], {
      language: "de-DE",
      cookieStore: { get: async () => ({ value: "fr" }) },
    });
    await unknown.dispatch("push", {});
    expect(unknown.notifications).toMatchObject([
      ["SubKit", { body: "Neue Einträge brauchen dich" }],
    ]);
    const other = worker([], { languages: ["fr-FR"] });
    await other.dispatch("push", {});
    expect(other.notifications).toMatchObject([["SubKit", { body: "New entries need you" }]]);
  });

  test("a hidden push keeps the worker alive briefly after the notification", async () => {
    const hidden = worker([]);
    await hidden.dispatch("push", {});
    expect(hidden.timeline).toEqual(["notify", "wait 1000"]);
    const visible = worker([windowClient(`${origin}/cockpit/`, "visible")]);
    await visible.dispatch("push", {});
    expect(visible.timeline).toEqual([]);
  });

  test("a click focuses an open Cockpit tab and never an installed app", async () => {
    const installed = windowClient(`${origin}/cockpit/i/11111111-1111-4111-8111-111111111111/`);
    const tab = windowClient(`${origin}/cockpit/flows`);
    const app = worker([installed, tab]);
    let closed = false;
    await app.dispatch("notificationclick", {
      notification: { close: () => (closed = true) },
    });
    expect(closed).toBeTrue();
    expect(tab.focused).toBeTrue();
    expect(installed.focused).toBeFalse();
    expect(app.opened).toEqual([]);
    expect(app.matchAllOptions).toEqual([{ type: "window", includeUncontrolled: true }]);
  });

  test("a click opens the Cockpit when only installed apps or foreign pages are open", async () => {
    const installed = windowClient(`${origin}/cockpit/i/11111111-1111-4111-8111-111111111111/`);
    const foreign = windowClient("https://other.example.test/cockpit/");
    const lookalike = windowClient(`${origin}/cockpitx`);
    const app = worker([installed, foreign, lookalike]);
    await app.dispatch("notificationclick", {
      notification: { close: () => {} },
    });
    expect(installed.focused || foreign.focused || lookalike.focused).toBeFalse();
    expect(app.opened).toEqual(["/cockpit/"]);
  });

  test("the canonical /cockpit path counts as the Cockpit tab", async () => {
    const tab = windowClient(`${origin}/cockpit`);
    const app = worker([tab]);
    await app.dispatch("notificationclick", {
      notification: { close: () => {} },
    });
    expect(tab.focused).toBeTrue();
  });
});
