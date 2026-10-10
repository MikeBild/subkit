import { afterAll, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { inspectorWidth } from "./responsive-workspace";

const dom = new JSDOM(
  '<!doctype html><html><body><button id="opener">Open</button><div id="root"></div></body></html>',
  {
    url: "http://localhost",
    pretendToBeVisual: true,
  },
);
const saved = new Map<string, PropertyDescriptor | undefined>();
let observer: ResizeObserverCallback;
let root: Root;

beforeAll(() => {
  if (!process.env.SUBKIT_RESPONSIVE_DOM_CHILD) return;
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
    ResizeObserver: class {
      constructor(callback: ResizeObserverCallback) {
        observer = callback;
      }
      observe() {}
      disconnect() {}
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

afterAll(async () => {
  if (!process.env.SUBKIT_RESPONSIVE_DOM_CHILD) return;
  if (root) {
    await act(async () => root.unmount());
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  }
  dom.window.close();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("reserves room only when both the list and requested inspector fit", () => {
  expect(inspectorWidth(1100, "default")).toBe(0);
  expect(inspectorWidth(1200, "default")).toBe(432);
  expect(inspectorWidth(1300, "wide")).toBe(0);
  expect(inspectorWidth(1600, "wide")).toBe(672);
});

test("resize preserves inspector state and focus while nested inspectors stay modal", async () => {
  if (!process.env.SUBKIT_RESPONSIVE_DOM_CHILD) {
    const child = Bun.spawnSync(
      [process.execPath, "test", import.meta.path, "-t", "resize preserves"],
      {
        env: { ...process.env, SUBKIT_RESPONSIVE_DOM_CHILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    return;
  }
  const { createRoot } = await import("react-dom/client");
  const { ResponsiveWorkspace } = await import("./responsive-workspace");
  const { RecordSheet } = await import("./record-sheet");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { I18nContext } = await import("@/lib/i18n-context");
  const { i18nValue } = await import("./test-utils");
  const changes: boolean[] = [];
  function StatefulContent() {
    const [count, setCount] = useState(0);
    return (
      <button type="button" data-testid="stateful" onClick={() => setCount(count + 1)}>
        State {count}
      </button>
    );
  }
  function Harness() {
    const [open, setOpen] = useState(true);
    const [nested, setNested] = useState(false);
    return (
      <I18nContext.Provider value={i18nValue()}>
        <TooltipProvider>
          <ResponsiveWorkspace>
            <button type="button" data-testid="nested-open" onClick={() => setNested(true)}>
              Nested
            </button>
            <RecordSheet
              dock
              open={open}
              onOpenChange={(value) => {
                changes.push(value);
                setOpen(value);
              }}
              title="Selected record"
              testId="record"
            >
              <StatefulContent />
            </RecordSheet>
            <RecordSheet
              dock
              open={nested}
              onOpenChange={setNested}
              title="Nested record"
              testId="nested"
            >
              Nested content
            </RecordSheet>
          </ResponsiveWorkspace>
        </TooltipProvider>
      </I18nContext.Provider>
    );
  }
  const query = (id: string) =>
    dom.window.document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const resize = async (width: number) =>
    act(async () => {
      observer([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
    });
  dom.window.document.getElementById("opener")?.focus();
  root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  await act(async () => root.render(<Harness />));
  await resize(900);
  expect(query("record").dataset.presentation).toBe("modal");
  const button = query("stateful");
  await act(async () => button.click());
  button.focus();
  await resize(1600);
  expect(query("record").dataset.presentation).toBe("docked");
  expect(query("stateful")).toBe(button);
  expect(button.textContent).toBe("State 1");
  expect(dom.window.document.activeElement).toBe(button);
  await resize(900);
  expect(query("record").dataset.presentation).toBe("modal");
  expect(query("stateful")).toBe(button);
  await resize(1600);
  await act(async () => query("nested-open").click());
  expect(query("nested").dataset.presentation).toBe("modal");
  expect(query("record").dataset.presentation).toBe("docked");
  expect(changes).toEqual([]);
  await act(async () => {
    query("nested").dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  await act(async () => {
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  });
  expect(query("nested")).toBeNull();
  expect(query("record").dataset.presentation).toBe("docked");
  expect(changes).toEqual([]);
  button.focus();
  await act(async () => {
    button.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(query("record")).toBeNull();
  expect(changes).toEqual([false]);
  expect(dom.window.document.activeElement).toBe(dom.window.document.getElementById("opener"));
});
