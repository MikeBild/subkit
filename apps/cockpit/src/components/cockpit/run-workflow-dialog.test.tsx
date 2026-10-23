import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { I18nContext } from "@/lib/i18n-context";

const CHILD_FLAG = "SUBKIT_RUN_DIALOG_DOM_CHILD";

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

async function dialogOpensOnMount(
  url: string,
  props: { openRequest?: number; openOnAnchor?: string },
): Promise<boolean> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url,
    pretendToBeVisual: true,
  });
  dom.window.scrollTo = () => {};
  dom.window.matchMedia = (media: string) =>
    ({
      matches: false,
      media,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
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
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    scrollTo: () => {},
    fetch: async () =>
      new Response(JSON.stringify({ schema: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { i18nValue } = await import("@/components/cockpit/patterns/test-utils");
  const { RunWorkflowDialog } = await import("./run-workflow-dialog");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  let root: Root | undefined;
  try {
    await router.load();
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={client}>
          <I18nContext.Provider value={i18nValue()}>
            <TooltipProvider>
              <RouterContextProvider router={router}>
                <RunWorkflowDialog
                  workflowId="wf-run"
                  workflowName="Daily report"
                  liveEnvironment="dev"
                  {...props}
                />
              </RouterContextProvider>
            </TooltipProvider>
          </I18nContext.Provider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      for (let round = 0; round < 8; round++)
        await new Promise<void>((resolve) => setImmediate(resolve));
    });
    return dom.window.document.querySelector('[data-testid="workflow-run-dialog"]') !== null;
  } finally {
    if (root) await act(async () => root?.unmount());
    client.clear();
    dom.window.close();
  }
}

isolated("a run requested while mounting opens the run dialog right away", async () => {
  expect(await dialogOpensOnMount("http://localhost/", { openRequest: 1 })).toBe(true);
});

isolated("the run anchor in the address opens the run dialog once", async () => {
  expect(
    await dialogOpensOnMount("http://localhost/#workflow-run", { openOnAnchor: "workflow-run" }),
  ).toBe(true);
});

isolated("without the run anchor the dialog stays closed", async () => {
  expect(await dialogOpensOnMount("http://localhost/", { openOnAnchor: "workflow-run" })).toBe(
    false,
  );
});
