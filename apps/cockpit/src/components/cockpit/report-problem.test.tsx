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

const CHILD_FLAG = "SUBKIT_REPORT_PROBLEM_DOM_CHILD";

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

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const reportWorkflow = {
  id: "wf-report",
  slug: "support-report-issue",
  name: "support-report-issue",
  lifecycle: "active",
  invalid: false,
  current_version_id: "ver-1",
  draft_version_id: null,
  current_version: 1,
  connector_references: [],
};

const approval = {
  execution_environment: "prod",
  state: "approved",
  active_version: true,
  ready_for_new_run: true,
  valid_from: "2020-01-01T00:00:00.000Z",
  valid_until: null,
  remaining_runs: null,
};

async function shown(items: unknown[], authorities: unknown[]) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
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
    fetch: async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/execution-authorities"))
        return json({ items: authorities, next_cursor: null });
      if (url.includes("/input-schema"))
        return json({
          source: "declared",
          schema: {
            type: "object",
            required: ["title", "description"],
            properties: {
              title: { type: "string", description: "One-line summary of the problem" },
              description: { type: "string", description: "What happened" },
            },
          },
        });
      if (url.includes("/v1/schedules")) return json({ schedules: [] });
      if (url.includes("/v1/workflows?")) return json({ items });
      return json({});
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { i18nValue } = await import("@/components/cockpit/patterns/test-utils");
  const { ReportProblem } = await import("./report-problem");
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
          <I18nContext.Provider value={i18nValue("de")}>
            <TooltipProvider>
              <RouterContextProvider router={router}>
                <ReportProblem permissions={["workflow:run", "workflow:read"]} />
              </RouterContextProvider>
            </TooltipProvider>
          </I18nContext.Provider>
        </QueryClientProvider>,
      );
    });
    for (let round = 0; round < 400; round++) {
      await act(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      const text = dom.window.document.body.textContent ?? "";
      const formOpen = dom.window.document.querySelector('[data-testid="workflow-run-dialog"]');
      if (!text.includes("Einen Moment bitte") && (!formOpen || text.includes("Kurz: worum")))
        break;
    }
    const body = dom.window.document.body;
    return {
      form: body.querySelector('[data-testid="workflow-run-dialog"]') !== null,
      notice: body.querySelector('[data-testid="report-problem-notice"]') !== null,
      text: body.textContent ?? "",
    };
  } finally {
    if (root) await act(async () => root?.unmount());
    client.clear();
    dom.window.close();
  }
}

isolated("a missing reporting workflow says in plain words that it is not set up", async () => {
  const result = await shown([], []);
  expect(result.form).toBe(false);
  expect(result.notice).toBe(true);
  expect(result.text).toContain(
    "Das Melden von Problemen ist hier noch nicht eingerichtet. Bitte sprich einen Administrator an.",
  );
});

isolated("a reporting workflow without a live approval is also not set up", async () => {
  const result = await shown([reportWorkflow], []);
  expect(result.form).toBe(false);
  expect(result.text).toContain("noch nicht eingerichtet");
});

isolated("an approved reporting workflow opens the form with plain wording", async () => {
  const result = await shown([reportWorkflow], [approval]);
  expect(result.form).toBe(true);
  expect(result.text).toContain("Problem melden");
  expect(result.text).toContain("Deine Meldung geht an das SubKit-Team");
  expect(result.text).toContain("Kurz: worum geht es?");
  expect(result.text).toContain("Bitte keine Passwörter, Schlüssel oder Kundendaten eintragen.");
  expect(result.text).toContain("Meldung senden");
  expect(result.text).not.toContain("One-line summary");
});
