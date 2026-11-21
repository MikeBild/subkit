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

const connector = "11111111-1111-4111-8111-111111111111";
let toolPinsCompared: boolean | undefined;
let toolDrift: "mcp_tool_changed" | "mcp_tool_unavailable" | null = null;

function previewFor(environment: "dev" | "prod") {
  return {
    digest: "d".repeat(64),
    eligible_for_repeated_runs: toolDrift === null,
    preparation_required: false,
    unavailable_steps: toolDrift ? ["lookup"] : [],
    request_refusals: toolDrift ? [{ step_id: "lookup", reason: toolDrift }] : [],
    storage_refusals: [],
    unbound_steps: [],
    schedules: [],
    approval_carries_over: false,
    ...(toolPinsCompared === undefined ? {} : { tool_pins_compared: toolPinsCompared }),
    environments: {
      dev: { possible: true, reasons: [] },
      prod: { possible: true, reasons: [] },
    },
    recommended_environment: { environment, reason: "only_possible" },
    boundary_growth: [],
    suggested_bounds: {
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: "2026-01-08T00:00:00.000Z",
      max_runs: 7,
    },
    execution_shape: { requests: [], iterations: [] },
    manifest: {
      schema_version: 1,
      tenant_id: "00000000-0000-4000-8000-000000000001",
      workflow_id: "wf-grant",
      workflow_version_id: "version-1",
      workflow_digest: "e".repeat(64),
      execution_environment: environment,
      execution_options_digest: "c".repeat(64),
      effects: [
        {
          tenant_id: "00000000-0000-4000-8000-000000000001",
          step_id: "lookup",
          connector_id: connector,
          driver: "mcp",
          environment,
          request_digest: "d".repeat(64),
          target: "https://tools.example.test/mcp#search",
          configuration_digest: "a".repeat(64),
          credential_binding_digest: "b".repeat(64),
          rewrites_target: false,
          operation: "tools/call:search",
          effect: "read",
          mcp: {
            server: "https://tools.example.test/mcp",
            tool: "search",
            effect: "read",
            variables: {},
            arguments: [],
            fixed_arguments_digest: "e".repeat(64),
            max_calls: 1,
            descriptor: {
              name: "search",
              annotations: { readOnlyHint: true },
              input_schema_digest: "f".repeat(64),
              digest: "0123456789abcdef".repeat(4),
            },
          },
        },
      ],
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
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
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
    return dom.window.document.body.innerHTML;
  } finally {
    if (root) await act(async () => root?.unmount());
    client.clear();
  }
}

const COMPARED = "Der Server führt dieses Tool als nur lesend";
const RECORDED = "SubKit hat das für dich nicht mit dem Server verglichen.";

isolated(
  "the dialog words the tool hint as the server's when the preview compared the pin",
  async () => {
    toolPinsCompared = true;
    const snapshot = await openedDialog({});
    expect(snapshot).toContain('data-testid="authority-effect-review"');
    expect(snapshot).toContain(COMPARED);
    expect(snapshot).not.toContain(RECORDED);
  },
);

isolated(
  "the dialog says the pin was not compared when the preview did not compare it",
  async () => {
    toolPinsCompared = false;
    const snapshot = await openedDialog({});
    expect(snapshot).toContain('data-testid="authority-effect-review"');
    expect(snapshot).toContain(RECORDED);
    expect(snapshot).not.toContain(COMPARED);
  },
);

isolated("a preview without the field is treated as not compared", async () => {
  toolPinsCompared = undefined;
  const snapshot = await openedDialog({});
  expect(snapshot).toContain(RECORDED);
  expect(snapshot).not.toContain(COMPARED);
});

isolated("a tool the server describes differently is named with its reason", async () => {
  toolPinsCompared = true;
  toolDrift = "mcp_tool_changed";
  const snapshot = await openedDialog({});
  expect(snapshot).toContain(
    "Schritt lookup: Der Server beschreibt dieses Tool anders, als der Schritt es festhält",
  );
  expect(snapshot).not.toContain("ließ sich gar nicht vorbereiten");
});
