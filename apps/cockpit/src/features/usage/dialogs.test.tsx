import { expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";

const CHILD_FLAG = "SUBKIT_USAGE_PRICE_DIALOG_DOM_CHILD";

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

type Call = { method: string; path: string; options: Record<string, unknown> };

isolated("saving a price keeps the models another editor stored meanwhile", async () => {
  const calls: Call[] = [];
  const alfa = { model: "alfa", input_per_mtok: 1, output_per_mtok: 2 };
  const actual = await import("@/api/call");
  mock.module("@/api/call", () => ({
    ...actual,
    apiCall: async (method: string, path: string, options: Record<string, unknown>) => {
      calls.push({ method, path, options });
      if (method === "get" && path === "/v1/settings/{path}") return { value: [alfa] };
      if (method === "get" && path === "/v1/stats/llm")
        return {
          groups: [
            { key: { model: "beta" }, model_price: { input_per_mtok: 3, output_per_mtok: 4 } },
          ],
        };
      return {};
    },
  }));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
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
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("@ui/molecules/tooltip");
  const { I18nContext } = await import("@/lib/i18n-context");
  const { i18nValue } = await import("@/components/cockpit/patterns/test-utils");
  const { PriceDialog } = await import("./dialogs");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const settle = () =>
    act(async () => {
      for (let round = 0; round < 8; round++)
        await new Promise<void>((resolve) => setImmediate(resolve));
    });
  const type = async (id: string, value: string) => {
    const input = dom.window.document.getElementById(id) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")
      ?.set as (this: HTMLInputElement, next: string) => void;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  let root: Root | undefined;
  try {
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={client}>
          <I18nContext.Provider value={i18nValue()}>
            <TooltipProvider>
              <PriceDialog
                open
                onOpenChange={() => {}}
                tenantId="tenant-a"
                canWriteGlobal={false}
                pricedBounds={{
                  window: "thisMonth",
                  from: "2026-11-01T00:00:00.000Z",
                  to: "2026-12-01T00:00:00.000Z",
                }}
                model="beta"
                modelName="Beta"
              />
            </TooltipProvider>
          </I18nContext.Provider>
        </QueryClientProvider>,
      );
    });
    await settle();
    await type("usage-price-input", "3");
    await type("usage-price-output", "4");
    const form = dom.window.document.querySelector(
      '[data-testid="usage-price-dialog"] form',
    ) as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    const write = calls.find((call) => call.method === "put");
    if (!write) throw new Error("no settings write");
    expect(write.options).toMatchObject({
      path: { path: "tokens.prices" },
      query: { tenant: "tenant-a" },
    });
    expect((write.options.body as { value: unknown }).value).toEqual([
      alfa,
      { model: "beta", input_per_mtok: 3, output_per_mtok: 4 },
    ]);
  } finally {
    if (root) await act(async () => root?.unmount());
    client.clear();
    dom.window.close();
  }
});
