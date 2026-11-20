import { expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { CONNECTOR_NAMES, TASK_ID } from "@/components/cockpit/task-grant-fixtures";
import type { TaskGrantPreview } from "@/components/cockpit/task-grant-model";
import type { Locale } from "@/lib/i18n";
import { I18nContext } from "@/lib/i18n-context";

const CHILD_FLAG = "SUBKIT_TASK_GRANT_DOM_CHILD";

export function isolatedIn(path: string) {
  return (name: string, body: () => Promise<void>) => {
    test(name, async () => {
      if (process.env[CHILD_FLAG] !== "1") {
        const child = Bun.spawnSync([process.execPath, "test", path, "-t", name], {
          env: { ...process.env, [CHILD_FLAG]: "1" },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
        return;
      }
      await body();
    });
  };
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface Answer {
  status?: number;
  body: unknown;
}

export interface Scene {
  previews: TaskGrantPreview[];
  previewRefusal?: Answer;
  grant?: Answer;
  revoke?: Answer;
  workflowPreview?: unknown;
  permissions?: string[];
  locale?: Locale;
}

export interface Stage {
  document: Document;
  calls: Call[];
  toasts: string[];
  click(testId: string): Promise<void>;
  open(testId: string): Promise<void>;
  text(testId?: string): string;
  has(testId: string): boolean;
  settle(): Promise<void>;
}

export async function staged(
  scene: Scene,
  element: () => Promise<ReactElement>,
  body: (stage: Stage) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/cockpit/tasks",
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
  const calls: Call[] = [];
  const toasts: string[] = [];
  const json = (answer: Answer) =>
    new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  let previewsServed = 0;
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
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({
        method,
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (path.endsWith("/grant-preview") && scene.previewRefusal)
        return json(scene.previewRefusal);
      if (path.endsWith("/grant-preview")) {
        const served = scene.previews[Math.min(previewsServed, scene.previews.length - 1)];
        previewsServed += 1;
        return json({ body: served });
      }
      if (path.endsWith("/revoke")) return json(scene.revoke ?? { body: {} });
      if (path.endsWith("/grants")) return json(scene.grant ?? { body: {} });
      if (path.endsWith("/authority-preview")) return json({ body: scene.workflowPreview ?? {} });
      if (path.endsWith(`/v1/tasks/${TASK_ID}`))
        return json({ body: { id: TASK_ID, name: "Rechnungen nachfassen" } });
      if (path.endsWith("/v1/connectors"))
        return json({
          body: {
            items: [...CONNECTOR_NAMES].map(([id, display_name]) => ({
              id,
              slug: display_name.toLowerCase(),
              display_name,
            })),
            total: CONNECTOR_NAMES.size,
          },
        });
      return json({ body: { items: [], total: 0 } });
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  mock.module("@/app/session", () => ({
    useSession: () => ({
      permissions: scene.permissions ?? [
        "task:read",
        "task:grant",
        "workflow:read",
        "connector:read",
      ],
    }),
  }));
  mock.module("sonner", () => ({
    toast: {
      success: (message: string) => toasts.push(`success:${message}`),
      error: (message: string) => toasts.push(`error:${message}`),
      info: (message: string) => toasts.push(`info:${message}`),
    },
  }));
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { i18nValue } = await import("@/components/cockpit/patterns/test-utils");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const turns = async () => {
    for (let round = 0; round < 30; round++)
      await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const settle = () =>
    act(async () => {
      await turns();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      await turns();
    });
  const find = (testId: string) =>
    dom.window.document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  let root: Root | undefined;
  try {
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    const tree = await element();
    await act(async () => {
      root?.render(
        <QueryClientProvider client={client}>
          <I18nContext.Provider value={i18nValue(scene.locale ?? "de")}>
            <TooltipProvider>{tree}</TooltipProvider>
          </I18nContext.Provider>
        </QueryClientProvider>,
      );
    });
    await settle();
    await body({
      document: dom.window.document,
      calls,
      toasts,
      settle,
      has: (testId) => find(testId) !== null,
      text: (testId) =>
        ((testId ? find(testId) : dom.window.document.body)?.innerHTML ?? "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      click: async (testId) => {
        const target = find(testId);
        expect(target, `missing ${testId}`).not.toBeNull();
        await act(async () => target?.click());
        await settle();
      },
      open: async (testId) => {
        const target = find(testId) as HTMLDetailsElement | null;
        expect(target, `missing ${testId}`).not.toBeNull();
        await act(async () => {
          if (target) target.open = true;
          target?.dispatchEvent(new dom.window.Event("toggle"));
        });
        await settle();
      },
    });
  } finally {
    if (root) await act(async () => root?.unmount());
    client.clear();
  }
}

export const posts = (calls: Call[], suffix: string) =>
  calls.filter((call) => call.method === "POST" && call.path.endsWith(suffix));

export const buttons = (document: Document, scope: string) =>
  [...document.querySelectorAll(`[data-testid="${scope}"] button`)].map((button) =>
    button.getAttribute("data-testid"),
  );
