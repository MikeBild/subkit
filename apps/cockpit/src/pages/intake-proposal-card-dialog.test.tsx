import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { IntakeProposal } from "@/api/intake";

const CHILD_FLAG = "SUBKIT_INTAKE_PROPOSAL_DIALOG_DOM_CHILD";

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

function proposal(overrides: Partial<IntakeProposal> = {}): IntakeProposal {
  return {
    id: "proposal",
    tenant_id: "tenant",
    status: "draft",
    current_revision: 1,
    confirmed_revision: null,
    confirmed_target_kind: null,
    confirmed_target_id: null,
    rejected_at: null,
    stale_reason: null,
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    revision: {
      revision: 1,
      digest: "digest",
      title: "Rollbacks zuerst",
      body: "Rollback first.",
      target: { name: "Produktwissen", category: "incident-review" },
      items: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          version: 1,
          title: "Sitzung",
          source_url: null,
        },
      ],
      created_at: "2026-01-02T00:00:00.000Z",
    },
    ...overrides,
  };
}

isolated(
  "open intake proposal dialogs close and stay closed after a proposal changes",
  async () => {
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
    const saved = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { createRoot } = await import("react-dom/client");
    const { I18nContext } = await import("@/lib/i18n-context");
    const { translate, translatePlural } = await import("@/lib/i18n");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { ProposalCard } = await import("./intake");
    let root: Root | undefined;
    const settle = () =>
      act(async () => {
        for (let round = 0; round < 8; round++)
          await new Promise<void>((resolve) => setImmediate(resolve));
      });
    const render = async (overrides?: Partial<IntakeProposal>) => {
      await act(async () => {
        root?.render(
          <TooltipProvider>
            <QueryClientProvider client={client}>
              <I18nContext.Provider
                value={{
                  locale: "de",
                  preference: "de",
                  setPreference() {},
                  t: (key, values) => translate("de", key, values),
                  tn: (key, count, values) => translatePlural("de", key, count, values),
                  dateTime: (date) => String(date),
                }}
              >
                <ProposalCard
                  proposal={proposal(overrides)}
                  permissions={["intake:confirm", "knowledge:write", "intake:write"]}
                  onConfirm={() => {}}
                  onReject={() => {}}
                />
              </I18nContext.Provider>
            </QueryClientProvider>
          </TooltipProvider>,
        );
      });
    };
    try {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      for (const action of ["confirm", "reject"] as const) {
        await render();
        const trigger = dom.window.document.querySelector(
          `[data-testid="intake-proposal-proposal-${action}"]`,
        ) as HTMLButtonElement;
        await act(async () => {
          trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        });
        await settle();
        const dialog = `[data-testid="intake-proposal-proposal-${action}-dialog"]`;
        expect(dom.window.document.querySelector(dialog)).not.toBeNull();
        await render({ status: "stale", stale_reason: "intake_item_admitted" });
        await settle();
        expect(dom.window.document.querySelector(dialog)).toBeNull();
        await render({ current_revision: 2 });
        await settle();
        expect(dom.window.document.querySelector(dialog)).toBeNull();
      }
    } finally {
      if (root) await act(async () => root?.unmount());
      client.clear();
      dom.window.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  },
);
