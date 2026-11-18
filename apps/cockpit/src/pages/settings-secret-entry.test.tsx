import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { SettingItem } from "@/pages/settings-model";

const CHILD_FLAG = "SUBKIT_SETTINGS_SECRET_DOM_CHILD";

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

function leaf(
  path: string,
  value: unknown,
  meta: Partial<SettingItem["meta"]> & { kind: string },
): SettingItem {
  return {
    path,
    value,
    meta: { source: "default", scope: "tenant", sensitive: false, requiresRestart: false, ...meta },
  };
}

const ITEMS: SettingItem[] = [
  leaf("llm.provider", "openai", { kind: "enum", enum_values: ["mock", "openai", "anthropic"] }),
  leaf("llm.model", "", { kind: "string", default: "" }),
  leaf("llm.api_key", "", { kind: "string", sensitive: true, default: "" }),
  leaf("llm.providers.openai.api_key", "***", { kind: "string", sensitive: true, default: "" }),
];
const KEY_INDEX = 3;
const REFERENCE = "secret://settings.llm.providers.openai.api_key/2";

function install(dom: JSDOM) {
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
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    scrollTo: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

isolated(
  "replacing a stored key opens the field and the key reaches the patch as a reference",
  async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: "http://localhost/settings?area=ai",
      pretendToBeVisual: true,
    });
    install(dom);
    const { createRoot } = await import("react-dom/client");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { I18nContext } = await import("@/lib/i18n-context");
    const { i18nValue } = await import("@/components/cockpit/patterns/test-utils");
    const { AiArea } = await import("@/pages/settings-ai");
    const model = await import("@/pages/settings-model");
    const { useSettingsDrafts } = await import("@/pages/settings-drafts");
    let latest: ReturnType<typeof useSettingsDrafts> | null = null;

    function Harness() {
      const state = useSettingsDrafts(ITEMS);
      latest = state;
      return (
        <AiArea
          ctx={{
            items: ITEMS,
            globalItems: ITEMS,
            tenantItems: null,
            effectiveItems: ITEMS,
            drafts: state.texts(ITEMS, "global"),
            canWrite: true,
            pending: false,
            scope: "global",
            scopeAvailable: false,
            catalog: { currency: "USD", models: [] },
            publicBaseUrl: "http://localhost",
            setDraft: (path, text) => state.setDraft(path, text, "global"),
            dropDraft: (path) => state.dropDraft(path, "global"),
            onScope() {},
            navigate() {},
          }}
        />
      );
    }

    let root: Root | undefined;
    try {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      await act(async () => {
        root?.render(
          <I18nContext.Provider value={i18nValue()}>
            <TooltipProvider>
              <Harness />
            </TooltipProvider>
          </I18nContext.Provider>,
        );
      });
      const document = dom.window.document;
      const replace = document.querySelector<HTMLButtonElement>(
        `[data-testid="setting-secret-edit-${KEY_INDEX}"]`,
      );
      expect(replace?.textContent).toBe("Schlüssel ersetzen");
      await act(async () => {
        replace?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
      const field = document.querySelector<HTMLInputElement>(
        `[data-testid="setting-input-${KEY_INDEX}"]`,
      );
      expect(field?.type).toBe("password");
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(field, "sk-new-key");
        field?.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      const state = latest as ReturnType<typeof useSettingsDrafts> | null;
      expect(state?.pending.global).toEqual({ "llm.providers.openai.api_key": "sk-new-key" });
      const patches = model.settingsPatches(
        { saved_revision: 3, items: ITEMS },
        state?.pending ?? model.NO_SETTING_DRAFTS,
        { global: { "llm.providers.openai.api_key": REFERENCE }, tenant: {} },
        null,
      );
      expect(patches).toEqual([
        {
          expected_revision: 3,
          scope: "global",
          changes: { "llm.providers.openai.api_key": REFERENCE },
        },
      ]);
    } finally {
      if (root) await act(async () => root?.unmount());
      dom.window.close();
    }
  },
);
