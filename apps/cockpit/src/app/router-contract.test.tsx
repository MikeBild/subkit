import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

const CHILD_FLAG = "SUBKIT_ROUTER_CONTRACT_CHILD";

function isolated(name: string, body: () => Promise<void>) {
  test(name, async () => {
    if (process.env[CHILD_FLAG] !== "1") {
      const child = Bun.spawnSync([process.execPath, "test", import.meta.path, "-t", name], {
        env: { ...process.env, [CHILD_FLAG]: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
      return;
    }
    await body();
  });
}

function installBrowser() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/cockpit/knowledge",
  });
  dom.window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    matchMedia: dom.window.matchMedia,
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, globalThis[name as keyof typeof globalThis]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return () => {
    for (const [name, value] of previous)
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    dom.window.close();
  };
}

isolated(
  "builds concrete catalog, knowledge and chat route components under the cockpit base path",
  async () => {
    const restore = installBrowser();
    try {
      const { router } = await import("./router");
      const routes = Object.values(router.routesById);
      const route = (path: string) => routes.find((candidate) => candidate.fullPath === path);

      expect(router.options.basepath).toBe("/cockpit");
      expect(route("/knowledge")?.options.component).toBeDefined();
      expect(route("/knowledge/$resourceId")?.options.component).toBeDefined();
      expect(route("/workflows/$resourceId")?.options.component).toBeDefined();
      expect(route("/connectors/$resourceId")?.options.component).toBeDefined();
      expect(route("/chat/$conversationId")?.options.component).toBeDefined();
    } finally {
      restore();
    }
  },
);
