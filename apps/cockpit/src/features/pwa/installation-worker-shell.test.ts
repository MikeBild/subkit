import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { workerSource } from "./worker-fixture";

const source = workerSource("installation-worker.js");
const origin = "https://app.example.test";
const scopePath = "/cockpit/i/11111111-1111-4111-8111-111111111111/";
const scope = `${origin}${scopePath}`;
const SHELL = ["/cockpit/assets/index-aaa.js", "/cockpit/assets/index-aaa.css"];

interface ClientFixture {
  id: string;
  url: string;
  visibilityState: "visible" | "hidden";
  focused: boolean;
  messages: unknown[];
  focus(): Promise<ClientFixture>;
  postMessage(message: unknown): void;
}

function client(path = "", visibilityState: "visible" | "hidden" = "hidden"): ClientFixture {
  const fixture: ClientFixture = {
    id: "client",
    url: `${scope}${path}`,
    visibilityState,
    focused: false,
    messages: [],
    postMessage: (message) => fixture.messages.push(message),
    focus: async () => {
      fixture.focused = true;
      return fixture;
    },
  };
  return fixture;
}

function sameOrigin(response: Response): Response {
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
}

interface Options {
  build?: string;
  shell?: string[];
  active?: boolean;
  caches?: Record<string, Record<string, Response>>;
  windows?: ClientFixture[];
  network?: (url: string, init?: RequestInit) => Promise<Response> | Response;
  locale?: string;
}

function worker(options: Options = {}) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const stores = new Map<string, Map<string, Response>>(
    Object.entries(options.caches ?? {}).map(([name, entries]) => [
      name,
      new Map(Object.entries(entries)),
    ]),
  );
  const fetched: string[] = [];
  const notifications: [string, Record<string, unknown>][] = [];
  const opened: string[] = [];
  const badges: (number | "flag" | "clear")[] = [];
  const calls: string[] = [];
  const network =
    options.network ??
    (async (url: string) =>
      url.includes("/assets/") ? sameOrigin(new Response(`body of ${url}`)) : new Response("{}"));
  const windows = options.windows ?? [];
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        match: async (url: string) => store.get(url)?.clone(),
        put: async (url: string, response: Response) => {
          store.set(url, response);
        },
      };
    },
  };
  const context: Record<string, unknown> = {
    URL,
    Response,
    Request,
    File,
    Uint8Array,
    Date,
    Set,
    Map,
    Promise,
    crypto: { randomUUID: () => "incoming-fixture" },
    setTimeout: (resolve: () => void) => resolve(),
    caches,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      fetched.push(url.replace(origin, ""));
      return await network(url, init);
    },
    self: {
      COCKPIT_BUILD: options.build,
      COCKPIT_SHELL: options.shell,
      navigator: {
        language: options.locale ?? "en-US",
        languages: [options.locale ?? "en-US"],
        setAppBadge: async (count?: number) => {
          badges.push(count === undefined ? "flag" : count);
        },
        clearAppBadge: async () => {
          badges.push("clear");
        },
      },
      registration: {
        scope,
        active: options.active ? {} : null,
        showNotification: async (title: string, shown: Record<string, unknown>) => {
          notifications.push([title, shown]);
        },
      },
      skipWaiting: async () => {
        calls.push("skipWaiting");
      },
      clients: {
        claim: async () => {
          calls.push("claim");
        },
        get: async () => windows[0] ?? client(),
        matchAll: async () => windows,
        openWindow: async (url: string) => {
          opened.push(url);
          return null;
        },
      },
      addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) =>
        handlers.set(name, handler),
    },
  };
  vm.runInNewContext(source, context);
  return {
    context,
    stores,
    fetched,
    notifications,
    opened,
    badges,
    calls,
    async dispatch(name: string, properties: Record<string, unknown> = {}) {
      let result: unknown;
      let completion: Promise<unknown> = Promise.resolve();
      handlers.get(name)?.({
        ...properties,
        respondWith: (value: Promise<unknown>) => {
          completion = Promise.resolve(value).then((response) => {
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

function navigation(path: string): Request {
  const request = new Request(`${scope}${path}`);
  Object.defineProperty(request, "mode", { value: "navigate" });
  return request;
}

type CacheName = (scopePath: string, build: string) => string;
type StaleCaches = (names: string[], scopePath: string, build: string) => string[];
type RequestRoute = (request: Request, scope: URL) => string;

describe("cache versioning", () => {
  const app = worker();
  const cacheName = app.context.cacheName as CacheName;
  const staleCaches = app.context.staleCaches as StaleCaches;

  test("one cache per installation and build", () => {
    expect(cacheName(scopePath, "abc")).toBe(`subkit-cockpit:${scopePath}:abc`);
    expect(cacheName(scopePath, "abc")).not.toBe(cacheName(scopePath, "abd"));
    expect(cacheName(scopePath, "abc")).not.toBe(cacheName("/cockpit/i/other/", "abc"));
  });

  test("only older builds of the same installation are stale", () => {
    const names = [
      cacheName(scopePath, "old"),
      cacheName(scopePath, "new"),
      cacheName("/cockpit/i/22222222-2222-4222-8222-222222222222/", "old"),
      "someone-else",
    ];
    expect(staleCaches(names, scopePath, "new")).toEqual([cacheName(scopePath, "old")]);
  });

  test("installing fills the cache of this build and takes over only a first install", async () => {
    const first = worker({ build: "b1", shell: SHELL });
    await first.dispatch("install");
    expect(first.fetched).toEqual(SHELL);
    expect([...(first.stores.get(`subkit-cockpit:${scopePath}:b1`)?.keys() ?? [])]).toEqual(SHELL);
    expect(first.calls).toEqual(["skipWaiting"]);
    const update = worker({ build: "b2", shell: SHELL, active: true });
    await update.dispatch("install");
    expect(update.calls).toEqual([]);
  });

  test("a file the server does not have is not cached and does not fail the install", async () => {
    const app = worker({
      build: "b1",
      shell: SHELL,
      network: (url) =>
        url.endsWith(".css") ? new Response("gone", { status: 404 }) : new Response("ok"),
    });
    await app.dispatch("install");
    expect([...(app.stores.get(`subkit-cockpit:${scopePath}:b1`)?.keys() ?? [])]).toEqual([
      SHELL[0] ?? "",
    ]);
  });

  test("activating drops older builds of this installation only", async () => {
    const other = "subkit-cockpit:/cockpit/i/22222222-2222-4222-8222-222222222222/:b1";
    const app = worker({
      build: "b2",
      caches: {
        [`subkit-cockpit:${scopePath}:b1`]: {},
        [`subkit-cockpit:${scopePath}:b2`]: {},
        [other]: {},
      },
    });
    await app.dispatch("activate");
    expect([...app.stores.keys()]).toEqual([`subkit-cockpit:${scopePath}:b2`, other]);
    expect(app.calls).toEqual(["claim"]);
  });

  test("a waiting build takes over when its own page asks, and names what it serves", async () => {
    const app = worker({ build: "b2", shell: SHELL, windows: [client()] });
    const replies: unknown[] = [];
    await app.dispatch("message", {
      origin,
      source: { id: "client" },
      data: { type: "describe-build" },
      ports: [{ postMessage: (value: unknown) => replies.push(value) }],
    });
    expect(replies).toEqual([{ build: "b2", shell: SHELL }]);
    await app.dispatch("message", {
      origin: "https://elsewhere.example.test",
      source: { id: "client" },
      data: { type: "activate-update" },
    });
    expect(app.calls).toEqual([]);
    await app.dispatch("message", {
      origin,
      source: { id: "client" },
      data: { type: "activate-update" },
    });
    expect(app.calls).toEqual(["skipWaiting"]);
    const foreign = client();
    foreign.url = `${origin}/cockpit/`;
    const refused = worker({ build: "b2", windows: [foreign] });
    await refused.dispatch("message", {
      origin,
      source: { id: "client" },
      data: { type: "activate-update" },
    });
    expect(refused.calls).toEqual([]);
  });
});

describe("what the worker answers itself", () => {
  const app = worker();
  const route = (request: Request) =>
    (app.context.requestRoute as RequestRoute)(request, new URL(scope));

  test("hashed bundle files and page loads, never the API or tenant files", () => {
    expect(route(new Request(`${origin}/cockpit/assets/index-aaa.js`))).toBe("asset");
    expect(route(navigation("tasks"))).toBe("page");
    expect(route(new Request(`${scope}api/v1/attention`))).toBe("pass");
    expect(route(navigation("api/v1/files/f1/content"))).toBe("pass");
    expect(route(new Request(`${scope}manifest.webmanifest`))).toBe("pass");
    expect(route(new Request(`${scope}icon/512.png?revision=3`))).toBe("pass");
    expect(route(new Request(`${origin}/cockpit/assets/index-aaa.js?x=1`))).toBe("pass");
    expect(route(new Request(`${origin}/cockpit/favicon.svg`))).toBe("pass");
    expect(route(new Request(`${origin}/cockpit/assets/x.js`, { method: "POST" }))).toBe("pass");
    expect(route(new Request("https://other.example.test/cockpit/assets/index-aaa.js"))).toBe(
      "pass",
    );
    expect(route(new Request(`${scope}incoming/share`, { method: "POST" }))).toBe("share");
  });

  test("API requests are left to the network and never stored", async () => {
    const live = worker({ build: "b1" });
    expect(
      await live.dispatch("fetch", { request: new Request(`${scope}api/v1/attention`) }),
    ).toBeUndefined();
    expect(live.fetched).toEqual([]);
    expect(live.stores.size).toBe(0);
  });

  test("a bundle file comes from the cache, a missing one is fetched once and kept", async () => {
    const live = worker({ build: "b1" });
    const request = () => new Request(`${origin}${SHELL[0]}`);
    const first = await live.dispatch("fetch", { request: request() });
    expect(await first?.text()).toBe(`body of ${origin}${SHELL[0]}`);
    const second = await live.dispatch("fetch", { request: request() });
    expect(await second?.text()).toBe(`body of ${origin}${SHELL[0]}`);
    expect(live.fetched).toEqual([SHELL[0] ?? ""]);
  });

  test("a response from elsewhere is not kept", async () => {
    const live = worker({ build: "b1", network: () => new Response("opaque") });
    await live.dispatch("fetch", { request: new Request(`${origin}${SHELL[0]}`) });
    expect(live.stores.get(`subkit-cockpit:${scopePath}:b1`)?.size).toBe(0);
  });

  test("a failed bundle request is passed on and not kept", async () => {
    const live = worker({ build: "b1", network: () => new Response("gone", { status: 404 }) });
    const response = await live.dispatch("fetch", {
      request: new Request(`${origin}${SHELL[0]}`),
    });
    expect(response?.status).toBe(404);
    expect(live.stores.get(`subkit-cockpit:${scopePath}:b1`)?.size).toBe(0);
  });

  test("a page load goes to the network and is never stored", async () => {
    const live = worker({ build: "b1", network: () => new Response("<html>fresh</html>") });
    const response = await live.dispatch("fetch", { request: navigation("tasks") });
    expect(await response?.text()).toBe("<html>fresh</html>");
    expect(live.stores.size).toBe(0);
  });

  test("without a connection a page load gets the offline page in the chosen language", async () => {
    const live = worker({
      locale: "de-DE",
      network: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const response = await live.dispatch("fetch", { request: navigation("tasks/t1?open=1") });
    const html = (await response?.text()) ?? "";
    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain('<html lang="de">');
    expect(html).toContain("Keine Verbindung zum Server");
    expect(html).toContain(`href="${scopePath}tasks/t1?open=1"`);
    expect(html).not.toContain("<script");
  });

  test("a gateway that cannot reach the server counts as no connection", async () => {
    for (const status of [502, 504]) {
      const live = worker({ network: () => new Response("bad gateway", { status }) });
      const response = await live.dispatch("fetch", { request: navigation("") });
      expect(await response?.text()).toContain("No connection to the server");
    }
    const refused = worker({ network: () => new Response("no", { status: 401 }) });
    expect((await refused.dispatch("fetch", { request: navigation("") }))?.status).toBe(401);
  });

  test("the retry address cannot carry markup", async () => {
    const live = worker({
      network: () => {
        throw new TypeError("offline");
      },
    });
    const response = await live.dispatch("fetch", {
      request: navigation('tasks?q="><img src=x onerror=alert(1)>'),
    });
    expect(await response?.text()).not.toContain("<img");
  });
});

describe("push in the installed app", () => {
  const push = (items: unknown[], more = 0) => ({
    data: { text: () => JSON.stringify({ type: "attention", items, more }) },
  });
  const item = { id: "connector:c1", class: "failing", severity: "urgent" };
  const attention = {
    items: [
      {
        id: "connector:c1",
        subject: { name: "Private CRM" },
        actions: [{ verb: "reauth", href: "/cockpit/connectors/c1", primary: true }],
      },
      { id: "workflow:w1", subject: { name: "Payroll" }, actions: [] },
    ],
  };

  test("with a session it names the next step, counts the badge and shows no names", async () => {
    const app = worker({ network: () => new Response(JSON.stringify(attention)) });
    await app.dispatch("push", push([{ ...item, href: "/cockpit/connectors/c1" }]));
    expect(app.fetched).toEqual([`${scopePath}api/v1/attention`]);
    expect(app.notifications).toEqual([
      [
        "Something is failing",
        {
          body: "Sign the connection in again.",
          icon: "/cockpit/app-icon-192.png",
          tag: `${scopePath}#connector:c1`,
          renotify: true,
          silent: false,
          data: { href: `${scopePath}connectors/c1` },
        },
      ],
    ]);
    expect(JSON.stringify(app.notifications)).not.toContain("Private CRM");
    expect(app.badges).toEqual([2]);
    expect(app.stores.size).toBe(0);
  });

  test("without a session it shows only what the payload carries", async () => {
    const app = worker({ network: () => new Response("{}", { status: 401 }) });
    await app.dispatch("push", push([{ ...item, href: null }], 1));
    expect(app.notifications.map(([title, shown]) => [title, shown.body])).toEqual([
      ["Something is failing", "Open the item in SubKit."],
      ["SubKit", "New entries need you"],
    ]);
    expect(app.badges).toEqual([2]);
  });

  test("an unreadable push still flags the badge", async () => {
    const app = worker({
      network: () => {
        throw new TypeError("offline");
      },
    });
    await app.dispatch("push", { data: { text: () => "not json" } });
    expect(app.notifications).toEqual([
      [
        "SubKit",
        {
          body: "New entries need you",
          icon: "/cockpit/app-icon-192.png",
          tag: scopePath,
          renotify: true,
        },
      ],
    ]);
    expect(app.badges).toEqual(["flag"]);
  });

  test("nothing open any more clears the badge", async () => {
    const app = worker({ network: () => new Response(JSON.stringify({ items: [] })) });
    await app.dispatch("push", push([]));
    expect(app.badges).toEqual(["clear"]);
  });

  test("a visible app window gets the hint and the worker asks the server nothing", async () => {
    const open = client("tasks", "visible");
    const app = worker({ windows: [open] });
    await app.dispatch("push", push([item]));
    expect(open.messages).toEqual([{ type: "attention" }]);
    expect(app.notifications).toEqual([]);
    expect(app.fetched).toEqual([]);
  });

  test("a click focuses the open window and sends it to the item", async () => {
    const open = client("tasks");
    const app = worker({ windows: [open] });
    let closed = false;
    await app.dispatch("notificationclick", {
      notification: {
        data: { href: `${scopePath}connectors/c1` },
        close: () => {
          closed = true;
        },
      },
    });
    expect(closed).toBeTrue();
    expect(open.focused).toBeTrue();
    expect(open.messages).toEqual([{ type: "open", href: `${scopePath}connectors/c1` }]);
    expect(app.opened).toEqual([]);
  });

  test("a click without an open window opens the item inside the installation", async () => {
    const app = worker();
    await app.dispatch("notificationclick", {
      notification: { data: { href: `${scopePath}connectors/c1` }, close: () => {} },
    });
    expect(app.opened).toEqual([`${scope}connectors/c1`]);
  });

  test("a click never leaves the installation", async () => {
    for (const href of ["https://evil.test/", "/cockpit/tasks", "//evil.test/x", 7]) {
      const app = worker();
      await app.dispatch("notificationclick", {
        notification: { data: { href }, close: () => {} },
      });
      expect(app.opened).toEqual([scope]);
    }
  });
});
