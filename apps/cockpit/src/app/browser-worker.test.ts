import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../public/browser-worker.js", import.meta.url), "utf8");
const origin = "https://app.example.test";
const scope = `${origin}/cockpit/`;

interface WindowClientFixture {
  url: string;
  focused: boolean;
  focus(): Promise<WindowClientFixture>;
}

function windowClient(url: string): WindowClientFixture {
  const client: WindowClientFixture = {
    url,
    focused: false,
    focus: async () => {
      client.focused = true;
      return client;
    },
  };
  return client;
}

function worker(windows: WindowClientFixture[] = []) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const notifications: unknown[] = [];
  const opened: unknown[] = [];
  const matchAllOptions: unknown[] = [];
  const calls: string[] = [];
  vm.runInNewContext(source, {
    URL,
    self: {
      location: { origin },
      registration: {
        scope,
        showNotification: (...args: unknown[]) => notifications.push(args),
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

  test("shows only a neutral notification for the Cockpit tab", async () => {
    const app = worker();
    await app.dispatch("push", { data: { text: () => "secret tenant workflow approval" } });
    expect(app.notifications).toEqual([
      [
        "SubKit",
        {
          body: "SubKit needs your attention.",
          icon: "/cockpit/app-icon-192.png",
          tag: "/cockpit/",
          renotify: true,
        },
      ],
    ]);
  });

  test("a click focuses an open Cockpit tab and never an installed app", async () => {
    const installed = windowClient(`${origin}/cockpit/i/11111111-1111-4111-8111-111111111111/`);
    const tab = windowClient(`${origin}/cockpit/flows`);
    const app = worker([installed, tab]);
    let closed = false;
    await app.dispatch("notificationclick", { notification: { close: () => (closed = true) } });
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
    await app.dispatch("notificationclick", { notification: { close: () => {} } });
    expect(installed.focused || foreign.focused || lookalike.focused).toBeFalse();
    expect(app.opened).toEqual(["/cockpit/"]);
  });

  test("the canonical /cockpit path counts as the Cockpit tab", async () => {
    const tab = windowClient(`${origin}/cockpit`);
    const app = worker([tab]);
    await app.dispatch("notificationclick", { notification: { close: () => {} } });
    expect(tab.focused).toBeTrue();
  });
});
