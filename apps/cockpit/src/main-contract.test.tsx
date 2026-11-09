import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";

const CHILD_FLAG = "SUBKIT_COCKPIT_MAIN_CHILD";

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

isolated(
  "mounts the recovery route through the production main entry without bootstrapping a session",
  async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: "http://localhost/cockpit/recovery",
      pretendToBeVisual: true,
    });
    dom.window.matchMedia = (query: string): MediaQueryList => {
      const media: MediaQueryList = {
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      };
      return media;
    };
    const globals: Record<string, unknown> = {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      Node: dom.window.Node,
      NodeFilter: dom.window.NodeFilter,
      MutationObserver: dom.window.MutationObserver,
      CustomEvent: dom.window.CustomEvent,
      Event: dom.window.Event,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      localStorage: dom.window.localStorage,
      matchMedia: dom.window.matchMedia,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      fetch: async () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals))
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    try {
      await act(async () => {
        await import("./main");
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      const markup = dom.window.document.body.innerHTML;
      expect(markup).toContain('data-testid="workspace-recovery-login"');
      expect(markup).toContain('role="alert"');
      expect(markup).not.toContain('data-testid="cockpit-shell"');
    } finally {
      dom.window.close();
    }
  },
);
