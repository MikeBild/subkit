import { expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { I18nContext } from "@/lib/i18n-context";

const CHILD_FLAG = "SUBKIT_GRANT_DIALOG_DOM_CHILD";

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

const block = (environment: "dev" | "prod") => ({
  code: "connector_missing",
  step_id: "ask",
  connector_id: "11111111-1111-4111-8111-111111111111",
  connector_name: `Support ${environment}`,
});

let previewRequests: unknown[] = [];

function previewFor(environment: "dev" | "prod") {
  return {
    digest: "digest",
    eligible_for_repeated_runs: false,
    preparation_required: false,
    unavailable_steps: [],
    schedules: [],
    environments: {
      dev: { possible: false, reasons: [block("dev")] },
      prod: { possible: false, reasons: [block("prod")] },
    },
    recommended_environment: { environment: null, reason: "none_possible" },
    boundary_growth: [],
    suggested_bounds: { valid_from: "2026-01-01T00:00:00.000Z" },
    execution_shape: { requests: previewRequests, iterations: [] },
    manifest: {
      workflow_id: "wf-grant",
      workflow_version_id: "version-1",
      execution_environment: environment,
      effects: [],
      issues: [],
    },
  };
}

async function openedDialog(props: Record<string, unknown>): Promise<string> {
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
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    scrollTo: () => {},
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input);
      const asked = new URL(url, "http://localhost").searchParams.get("environment");
      if (url.includes("/authority-preview"))
        return json(previewFor(asked === "prod" ? "prod" : "dev"));
      if (url.endsWith("/v1/workflows/wf-grant")) return json({ name: "Daily report" });
      return json({ items: [], total: 0, diagnoses: [], proposals: [], unproposable: [] });
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  mock.module("@/app/session", () => ({
    useSession: () => ({
      permissions: ["workflow:read", "workflow:run", "workflow:write", "execution:read"],
    }),
  }));
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { i18nValue } = await import("@/components/cockpit/patterns/test-utils");
  const { GrantWorkflowAuthority } = await import("./grant-workflow-authority");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: Root | undefined;
  try {
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={client}>
          <I18nContext.Provider value={i18nValue()}>
            <TooltipProvider>
              <GrantWorkflowAuthority workflowId="wf-grant" versionId="version-1" {...props} />
            </TooltipProvider>
          </I18nContext.Provider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      dom.window.document
        .querySelector<HTMLElement>('[data-testid="authority-grant-open"]')
        ?.click();
    });
    await act(async () => {
      for (let round = 0; round < 30; round++)
        await new Promise<void>((resolve) => setImmediate(resolve));
    });
    await act(async () => {
      dom.window.document
        .querySelector<HTMLElement>('[data-testid="authority-effect-details-toggle"]')
        ?.click();
    });
    return dom.window.document.body.innerHTML;
  } finally {
    if (root) await act(async () => root?.unmount());
    client.clear();
  }
}

isolated(
  "with neither environment possible the way forward stays and no approval is offered",
  async () => {
    const snapshot = await openedDialog({
      activation: { expected_current_version_id: null },
      onAdjust: () => {},
      onSingleRun: () => {},
    });
    const present = (id: string) => snapshot.includes(`data-testid="${id}"`);
    expect(present("authority-decision-blocked")).toBe(true);
    expect(present("authority-adjust")).toBe(true);
    expect(present("authority-single-run")).toBe(true);
    expect(present("authority-activate-only")).toBe(true);
    expect(present("authority-grant-confirm")).toBe(false);
    expect(present("authority-limit")).toBe(false);
    expect(present("authority-start-run")).toBe(false);
    expect(present("authority-write-check")).toBe(false);
  },
);

isolated("without a single-run path the adjust link stays", async () => {
  const snapshot = await openedDialog({});
  expect(snapshot).toContain('data-testid="authority-adjust"');
  expect(snapshot).not.toContain('data-testid="authority-grant-confirm"');
  expect(snapshot).not.toContain('data-testid="authority-single-run"');
});

isolated("each request names its method and target next to its content", async () => {
  previewRequests = [
    {
      step_id: "send",
      target: { method: "POST", url: "https://api.example.test/v1/messages" },
      retry_policy_max_attempts: 5,
      redacted_request_json: "{}",
      request_review_truncated: false,
      opaque_payload_omitted: false,
    },
    {
      step_id: "lookup",
      target: { method: "GET", url: null },
      retry_policy_max_attempts: 5,
      redacted_request_json: "{}",
      request_review_truncated: false,
      opaque_payload_omitted: false,
    },
  ];
  const snapshot = await openedDialog({});
  expect(snapshot).toContain("Ziel: POST https://api.example.test/v1/messages");
  expect(snapshot).toContain("Ziel: GET, die Adresse steht erst beim Start des Runs fest");
});
