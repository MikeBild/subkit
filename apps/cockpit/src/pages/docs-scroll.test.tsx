import { describe, expect, mock, test } from "bun:test";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { DOCS } from "@/app/docs.generated";
import { i18nValue } from "@/components/cockpit/patterns/test-utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nContext } from "@/lib/i18n-context";
import { DocsArticleView } from "./docs";
import { article, findPage } from "./docs-model";

const CHILD_FLAG = "SUBKIT_DOCS_SCROLL_DOM_CHILD";

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

function sections(slug: string) {
  const page = findPage(DOCS, slug);
  if (!page) throw new Error(`${slug} chapter is missing`);
  const [first, second] = article(page, "de").toc;
  if (!first || !second) throw new Error(`${slug} needs two sections`);
  return { first, second };
}

interface Harness {
  dom: JSDOM;
  router: AnyRouter;
  scrolled: string[];
  region(): HTMLElement;
  settle(): Promise<void>;
  close(): Promise<void>;
}

async function mount(initial: string): Promise<Harness> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `http://localhost${initial}`,
    pretendToBeVisual: true,
  });
  const scrolled: string[] = [];
  const positions = new WeakMap<Element, number>();
  const proto = dom.window.HTMLElement.prototype;
  proto.scrollIntoView = mock(function (this: Element) {
    scrolled.push(this.id);
  });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return positions.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      positions.set(this, value);
    },
  });
  proto.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
    this.scrollTop = typeof options === "object" ? (options.top ?? 0) : 0;
    this.dispatchEvent(new dom.window.Event("scroll"));
  } as HTMLElement["scrollTo"];
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
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  function Chapter() {
    const { slug } = useParams({ strict: false }) as { slug: string };
    return (
      <div data-family-slot="scroll-region" data-testid="docs-scroll">
        <DocsArticleView bundle={DOCS} slug={slug} version="1.2.3" />
      </div>
    );
  }
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/docs/$slug", component: Chapter }),
    ]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  const { createRoot } = await import("react-dom/client");
  let root: Root | undefined;
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  await router.load();
  root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  await act(async () => {
    root?.render(
      <I18nContext.Provider value={i18nValue("de")}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </I18nContext.Provider>,
    );
  });
  await settle();
  return {
    dom,
    router: router as unknown as AnyRouter,
    scrolled,
    region: () => dom.window.document.querySelector('[data-testid="docs-scroll"]') as HTMLElement,
    settle,
    close: async () => {
      if (root) await act(async () => root?.unmount());
      dom.window.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

describe("docs deep links", () => {
  isolated(
    "a chapter address with an anchor scrolls to that heading and marks it in the toc",
    async () => {
      const { first, second } = sections("web-clipper");
      const view = await mount(`/docs/web-clipper#${first.anchor}`);
      const currentToc = () =>
        [...view.dom.window.document.querySelectorAll('[data-testid="docs-toc-link"]')]
          .filter((link) => link.getAttribute("aria-current") === "page")
          .map((link) => link.getAttribute("href"));
      try {
        expect(view.dom.window.document.getElementById(first.anchor)).not.toBeNull();
        expect(view.scrolled).toContain(first.anchor);
        expect(new Set(currentToc())).toEqual(new Set([`/docs/web-clipper#${first.anchor}`]));

        await act(async () => {
          await view.router.navigate({
            to: "/docs/$slug",
            params: { slug: "web-clipper" },
            hash: second.anchor,
          });
        });
        await view.settle();
        expect(view.scrolled.at(-1)).toBe(second.anchor);
        expect(new Set(currentToc())).toEqual(new Set([`/docs/web-clipper#${second.anchor}`]));

        await act(async () => {
          view.router.history.back();
        });
        await view.settle();
        expect(view.scrolled.at(-1)).toBe(first.anchor);
      } finally {
        await view.close();
      }
    },
  );

  isolated("clicking the current toc entry again scrolls to its heading again", async () => {
    const { first } = sections("web-clipper");
    const view = await mount(`/docs/web-clipper#${first.anchor}`);
    try {
      const link = view.dom.window.document.querySelector(
        `[data-testid="docs-toc-link"][href="/docs/web-clipper#${first.anchor}"]`,
      );
      if (!link) throw new Error("toc link is missing");
      const before = view.scrolled.filter((id) => id === first.anchor).length;
      expect(before).toBeGreaterThan(0);
      await act(async () => {
        link.dispatchEvent(
          new view.dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
        );
      });
      await view.settle();
      expect(view.scrolled.filter((id) => id === first.anchor).length).toBeGreaterThan(before);
    } finally {
      await view.close();
    }
  });

  isolated(
    "a new chapter starts at the top and back returns to where the reader left off",
    async () => {
      const other = DOCS.pages.find((page) => page.slug !== "web-clipper");
      if (!other) throw new Error("a second chapter is missing");
      const view = await mount("/docs/web-clipper");
      try {
        const region = view.region();
        await act(async () => {
          region.scrollTop = 640;
          region.dispatchEvent(new view.dom.window.Event("scroll"));
        });

        await act(async () => {
          await view.router.navigate({ to: "/docs/$slug", params: { slug: other.slug } });
        });
        await view.settle();
        expect(view.region()).toBe(region);
        expect(region.scrollTop).toBe(0);

        await act(async () => {
          view.router.history.back();
        });
        await view.settle();
        expect(view.router.state.location.pathname).toBe("/docs/web-clipper");
        expect(region.scrollTop).toBe(640);

        await act(async () => {
          view.router.history.forward();
        });
        await view.settle();
        expect(region.scrollTop).toBe(0);
      } finally {
        await view.close();
      }
    },
  );
});
