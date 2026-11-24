import { afterAll, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, type ReactElement, useState } from "react";
import type { Root } from "react-dom/client";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "http://localhost",
  pretendToBeVisual: true,
});
const saved = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined;
const isChild = Boolean(process.env.SUBKIT_FOCUS_DOM_CHILD);

beforeAll(() => {
  if (!isChild) return;
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    PointerEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

afterAll(async () => {
  if (!isChild) return;
  if (root) await act(async () => root?.unmount());
  dom.window.close();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const runInChild = (name: string) => {
  const child = Bun.spawnSync([process.execPath, "test", import.meta.path, "-t", name], {
    env: { ...process.env, SUBKIT_FOCUS_DOM_CHILD: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
};

const query = (id: string) =>
  dom.window.document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const focusedId = () => {
  const active = dom.window.document.activeElement;
  return active?.getAttribute("data-testid") ?? active?.tagName ?? null;
};
const settle = () =>
  act(async () => {
    for (let frame = 0; frame < 3; frame++)
      await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  });
const press = (target: HTMLElement, key: string) =>
  act(async () => {
    target.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });

async function mount(element: ReactElement) {
  const { createRoot } = await import("react-dom/client");
  const { UiProvider } = await import("@ui/lib/ui-context");
  const { TooltipProvider } = await import("@ui/molecules/tooltip");
  const { I18nContext } = await import("@/lib/i18n-context");
  const { i18nValue } = await import("./test-utils");
  const { Workflow } = await import("lucide-react");
  const { errorCatalog } = await import("@shared/error-catalog.ts");
  root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  await act(async () =>
    root?.render(
      <I18nContext.Provider value={i18nValue()}>
        <UiProvider lang="de" mark={Workflow} appName="SubKit" errors={errorCatalog("de")}>
          <TooltipProvider>{element}</TooltipProvider>
        </UiProvider>
      </I18nContext.Provider>,
    ),
  );
}

test("controlled confirm dialog returns focus to its opener after cancel", async () => {
  if (!isChild) return runInChild("controlled confirm dialog");
  const { ConfirmDialog } = await import("@ui/organisms/confirm-dialog");
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
          Delete
        </button>
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Delete?"
          consequence="Gone."
          onConfirm={() => setOpen(false)}
          testId="confirm"
        />
      </>
    );
  }
  await mount(<Harness />);
  const opener = query("opener") as HTMLElement;
  opener.focus();
  await act(async () => opener.click());
  await settle();
  expect(query("confirm")).not.toBeNull();
  await act(async () => query("confirm-cancel")?.click());
  await settle();
  expect(query("confirm")).toBeNull();
  expect(focusedId()).toBe("opener");
});

test("dialog opened from action menu returns focus to the menu trigger", async () => {
  if (!isChild) return runInChild("dialog opened from action menu");
  const { ConfirmDialog } = await import("@ui/organisms/confirm-dialog");
  const { ActionMenu } = await import("./action-menu");
  function Harness() {
    const [deleting, setDeleting] = useState(false);
    return (
      <>
        <ActionMenu
          testId="more"
          items={[
            { label: "Edit", onSelect() {}, testId: "edit" },
            { label: "Delete", onSelect: () => setDeleting(true), testId: "delete" },
          ]}
        />
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title="Delete?"
          consequence="Gone."
          onConfirm={() => setDeleting(false)}
          testId="confirm"
        />
      </>
    );
  }
  await mount(<Harness />);
  const trigger = query("more") as HTMLElement;
  trigger.focus();
  await press(trigger, "Enter");
  await settle();
  const item = query("delete") as HTMLElement;
  expect(item).not.toBeNull();
  item.focus();
  await press(item, "Enter");
  await settle();
  expect(query("delete")).toBeNull();
  const dialog = query("confirm") as HTMLElement;
  expect(dialog).not.toBeNull();
  await press(dialog, "Escape");
  await settle();
  expect(query("confirm")).toBeNull();
  expect(focusedId()).toBe("more");
});
