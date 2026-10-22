import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("../../public/installation-worker.js", import.meta.url),
  "utf8",
);
const scope = "https://app.example.test/cockpit/i/11111111-1111-4111-8111-111111111111/";

interface WindowClientFixture {
  url: string;
  focused: boolean;
  navigated: string[];
  focus(): Promise<WindowClientFixture>;
  navigate(url: string): Promise<WindowClientFixture>;
}

function windowClient(url: string): WindowClientFixture {
  const client: WindowClientFixture = {
    url,
    focused: false,
    navigated: [],
    focus: async () => {
      client.focused = true;
      return client;
    },
    navigate: async (target: string) => {
      client.navigated.push(target);
      client.url = target;
      return client;
    },
  };
  return client;
}

function worker(authenticated = true, windows: WindowClientFixture[] = []) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const sent: unknown[] = [];
  const notifications: unknown[] = [];
  const opened: unknown[] = [];
  const matchAllOptions: unknown[] = [];
  let clientUrl = scope;
  vm.runInNewContext(source, {
    URL,
    Response,
    Request,
    File,
    Uint8Array,
    Date,
    crypto: { randomUUID: () => "incoming-fixture" },
    fetch: async () =>
      new Response(JSON.stringify({ tenant: { id: "tenant" }, principal: { id: "owner" } }), {
        status: authenticated ? 200 : 401,
      }),
    self: {
      registration: { scope, showNotification: (...args: unknown[]) => notifications.push(args) },
      skipWaiting: () => {},
      clients: {
        claim: () => {},
        get: async () => ({ url: clientUrl, postMessage: (value: unknown) => sent.push(value) }),
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
    sent,
    notifications,
    opened,
    matchAllOptions,
    client: (url: string) => {
      clientUrl = url;
    },
    async dispatch(name: string, properties: Record<string, unknown>) {
      let result: unknown;
      let completion: Promise<unknown> = Promise.resolve();
      handlers.get(name)?.({
        ...properties,
        respondWith: (value: Promise<unknown>) => {
          completion = value.then((response) => {
            result = response;
          });
        },
        waitUntil: (value: Promise<unknown>) => {
          completion = Promise.resolve(value);
        },
      });
      await completion;
      return result as Response | undefined;
    },
  };
}

function share(body: string) {
  const form = new FormData();
  form.set("text", body);
  return new Request(`${scope}incoming/share`, { method: "POST", body: form });
}

describe("installation worker privacy boundary", () => {
  test("intercepts only scoped incoming shares and never caches ordinary API responses", async () => {
    const app = worker();
    expect(
      await app.dispatch("fetch", { request: new Request(`${scope}api/v1/files`) }),
    ).toBeUndefined();
    expect(await app.dispatch("fetch", { request: share("private source") })).toBeInstanceOf(
      Response,
    );
    expect(source).not.toMatch(/caches\.|indexedDB|localStorage|sync\.register/);
  });
  test("requires authentication before retaining incoming content", async () => {
    const app = worker(false);
    const response = await app.dispatch("fetch", { request: share("private source") });
    expect(response?.headers.get("location")).toBe(`${scope}?incoming=sign-in`);
    await app.dispatch("message", {
      source: { id: "client" },
      data: { type: "take-incoming", id: "incoming-fixture" },
    });
    expect(app.sent).toEqual([{ type: "incoming-unavailable" }]);
  });
  test("hands volatile content to the same app once, with its authenticated identity", async () => {
    const app = worker();
    await app.dispatch("fetch", { request: share("private source") });
    app.client("https://app.example.test/cockpit/i/22222222-2222-4222-8222-222222222222/");
    await app.dispatch("message", {
      source: { id: "client" },
      data: { type: "take-incoming", id: "incoming-fixture" },
    });
    expect(app.sent).toEqual([]);
    app.client(scope);
    await app.dispatch("message", {
      source: { id: "client" },
      data: { type: "take-incoming", id: "incoming-fixture" },
    });
    expect(app.sent[0]).toMatchObject({
      type: "incoming",
      value: { text: "private source", tenantId: "tenant", userId: "owner" },
    });
    await app.dispatch("message", {
      source: { id: "client" },
      data: { type: "take-incoming", id: "incoming-fixture" },
    });
    expect(app.sent[1]).toEqual({ type: "incoming-unavailable" });
  });
  test("clears incoming content and keeps push payloads neutral", async () => {
    const app = worker();
    await app.dispatch("fetch", { request: share("private source") });
    await app.dispatch("message", { source: { id: "client" }, data: { type: "clear-incoming" } });
    await app.dispatch("message", {
      source: { id: "client" },
      data: { type: "take-incoming", id: "incoming-fixture" },
    });
    expect(app.sent).toEqual([{ type: "incoming-unavailable" }]);
    await app.dispatch("push", { data: { text: () => "secret tenant workflow approval" } });
    expect(app.notifications).toEqual([
      [
        "SubKit",
        {
          body: "SubKit needs your attention.",
          icon: "/cockpit/app-icon-192.png",
          tag: new URL(scope).pathname,
          renotify: true,
        },
      ],
    ]);
    await app.dispatch("notificationclick", { notification: { close: () => {} } });
    expect(app.opened).toEqual([scope]);
  });
  test("a notification click focuses the open app instead of opening another window", async () => {
    const foreign = windowClient("https://app.example.test/cockpit/");
    const app = windowClient(`${scope}runs`);
    const opened = worker(true, [foreign, app]);
    await opened.dispatch("notificationclick", { notification: { close: () => {} } });
    expect(app.focused).toBeTrue();
    expect(foreign.focused).toBeFalse();
    expect(opened.opened).toEqual([]);
    expect(opened.matchAllOptions).toEqual([{ type: "window", includeUncontrolled: true }]);
  });
  test("a notification click opens the app scope when no app window is open", async () => {
    const foreign = windowClient(
      "https://app.example.test/cockpit/i/22222222-2222-4222-8222-222222222222/",
    );
    const opened = worker(true, [foreign]);
    await opened.dispatch("notificationclick", { notification: { close: () => {} } });
    expect(foreign.focused).toBeFalse();
    expect(opened.opened).toEqual([scope]);
  });
  test("rejects oversized input before it reaches an app", async () => {
    const app = worker();
    const request = new Request(`${scope}incoming/share`, {
      method: "POST",
      body: "x",
      headers: { "content-length": String(26 * 1024 * 1024) },
    });
    const response = await app.dispatch("fetch", { request });
    expect(response?.headers.get("location")).toBe(`${scope}?incoming=retry`);
  });
});
