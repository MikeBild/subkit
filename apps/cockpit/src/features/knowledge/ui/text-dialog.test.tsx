import { expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { KnowledgeSource } from "../hooks/use-source";

const CHILD_FLAG = "SUBKIT_KNOWLEDGE_TEXT_DIALOG_DOM_CHILD";

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

isolated("cancel discards the unsaved draft and note before the dialog reopens", async () => {
  const savedContent = "# Saved runbook";
  const saveCalls: unknown[] = [];
  const sourceHooks = await import("../hooks/use-source");
  const editHooks = await import("../hooks/use-source-edits");
  const knowledgeQueries = await import("../queries");
  mock.module("../hooks/use-source", () => ({
    ...sourceHooks,
    useSourceContent: () => ({
      data: {
        editable: true,
        version: 3,
        documents: [{ path: "runbook.md", content: savedContent }],
      },
    }),
  }));
  mock.module("../hooks/use-source-edits", () => ({
    ...editHooks,
    useSaveSourceText: () => ({
      isPending: false,
      mutate: (body: unknown) => saveCalls.push(body),
    }),
  }));
  mock.module("../queries", () => ({
    ...knowledgeQueries,
    useMarkdownRefs: () => ({ groups: [], search: "" }),
  }));
  mock.module("@ui/organisms/markdown-editor", () => ({
    MarkdownEditor: ({
      id,
      value,
      onChange,
    }: {
      id: string;
      value: string;
      onChange: (next: string) => void;
    }) => (
      <textarea
        data-testid="editor"
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    ),
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
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
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
  const { createRoot } = await import("react-dom/client");
  const { I18nContext } = await import("@/lib/i18n-context");
  const { translate, translatePlural } = await import("@/lib/i18n");
  const { TextDialog } = await import("./text-dialog");
  const source = { id: "source", name: "Runbook" } as KnowledgeSource;
  let root: Root | undefined;
  let openState = true;
  const settle = () =>
    act(async () => {
      for (let round = 0; round < 8; round++)
        await new Promise<void>((resolve) => setImmediate(resolve));
    });
  const render = async (open: boolean) => {
    openState = open;
    await act(async () => {
      root?.render(
        <I18nContext.Provider
          value={{
            locale: "en",
            preference: "en",
            setPreference() {},
            t: (key, values) => translate("en", key, values),
            tn: (key, count, values) => translatePlural("en", key, count, values),
            dateTime: (date) => String(date),
          }}
        >
          <TextDialog
            open={openState}
            onOpenChange={(next) => {
              openState = next;
            }}
            src={source}
          />
        </I18nContext.Provider>,
      );
    });
    await settle();
  };
  const query = <T extends Element>(testId: string) =>
    dom.window.document.querySelector(`[data-testid="${testId}"]`) as T | null;
  const typeInto = async (element: HTMLInputElement | HTMLTextAreaElement, text: string) => {
    const prototype = Object.getPrototypeOf(element);
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, text);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  try {
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    await render(true);
    const editor = query<HTMLTextAreaElement>("editor");
    const note = query<HTMLInputElement>("src-note");
    expect(editor?.value).toBe(savedContent);
    await typeInto(editor as HTMLTextAreaElement, "unsaved draft");
    await typeInto(note as HTMLInputElement, "unsaved note");
    expect(query<HTMLTextAreaElement>("editor")?.value).toBe("unsaved draft");
    await act(async () => {
      query<HTMLButtonElement>("common-cancel-3")?.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    expect(openState).toBe(false);
    await render(false);
    await render(true);
    expect(query<HTMLTextAreaElement>("editor")?.value).toBe(savedContent);
    expect(query<HTMLInputElement>("src-note")?.value).toBe("");
    expect(saveCalls).toHaveLength(0);
  } finally {
    if (root) await act(async () => root?.unmount());
    dom.window.close();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
