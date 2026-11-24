import { expect, test } from "bun:test";
import type { components } from "@cli-core/engine-api/openapi";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { act } from "react";

const CHILD_FLAG = "SUBKIT_RERUN_DOM_CHILD";

test("rerun controls share pending state for the same run", async () => {
  if (process.env[CHILD_FLAG] !== "1") {
    const child = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      env: { ...process.env, [CHILD_FLAG]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    return;
  }
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost",
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  dom.window.matchMedia = (media: string) =>
    ({
      matches: false,
      media,
      onchange: null,
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
      addEventListener() {},
      removeEventListener() {},
    }) as MediaQueryList;
  notifyManager.setScheduler(queueMicrotask);
  const { createRoot } = await import("react-dom/client");
  const { I18nContext } = await import("@/lib/i18n-context");
  const { i18nValue } = await import("@/components/cockpit/patterns/test-utils");
  const { RerunAction } = await import("./runs-detail");
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const run = { id: "run-a", status: "failed" } as components["schemas"]["Execution"];
  const other = { ...run, id: "run-b" };
  for (const item of [run, other]) {
    client.setQueryData(["run", item.id, "rerun-safety"], {
      outcome: { rerun_safety: { mode: "safe" } },
    });
  }
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let finish!: (response: Response) => void;
  globalThis.fetch = (() => {
    requests++;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }) as unknown as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nContext.Provider value={i18nValue("en")}>
            <RerunAction run={run} onStarted={() => {}} />
            <RerunAction run={run} onStarted={() => {}} />
            <RerunAction run={other} onStarted={() => {}} />
          </I18nContext.Provider>
        </QueryClientProvider>,
      );
    });
    const buttons = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    await act(async () => {
      buttons[0]?.click();
    });
    expect(requests).toBe(1);
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[1]?.disabled).toBe(true);
    expect(buttons[2]?.disabled).toBe(false);
    await act(async () => {
      buttons[1]?.click();
    });
    expect(requests).toBe(1);
    await act(async () => {
      finish(Response.json({ execution_id: "next-run" }));
    });
    expect(buttons[0]?.disabled).toBe(false);
    expect(buttons[1]?.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
