import { describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { loginHref } from "@/app/session";
import { i18nValue, render } from "@/components/cockpit/patterns/test-utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nContext } from "@/lib/i18n-context";
import {
  BootstrapErrorPage,
  ForbiddenState,
  NotFoundPage,
  queryView,
  SessionExpiredPage,
} from "./failure-state";

const empty = (data: { items: unknown[] }) => data.items.length === 0;
const base = { data: undefined, error: null, failureReason: null, isPending: true };

describe("queryView", () => {
  test("nothing yet and nothing wrong is loading", () => {
    expect(queryView<{ items: unknown[] }>(base, empty)).toBe("loading");
  });

  test("a failed read is an error, not an empty list", () => {
    expect(
      queryView<{ items: unknown[] }>(
        { ...base, isPending: false, error: new Error("500") },
        empty,
      ),
    ).toBe("error");
  });

  test("the first failure already counts, while the query is still retrying", () => {
    expect(
      queryView<{ items: unknown[] }>({ ...base, failureReason: new Error("500") }, empty),
    ).toBe("error");
  });

  test("rows are ready, no rows are empty", () => {
    expect(queryView({ ...base, isPending: false, data: { items: [1] } }, empty)).toBe("ready");
    expect(queryView({ ...base, isPending: false, data: { items: [] } }, empty)).toBe("empty");
  });

  test("data already on screen stays while a refresh fails", () => {
    expect(
      queryView(
        { ...base, isPending: false, data: { items: [1] }, error: new Error("500") },
        empty,
      ),
    ).toBe("ready");
  });
});

describe("ForbiddenState", () => {
  test("explains the denied page and names an administrator to contact, in both languages", () => {
    const de = render(<ForbiddenState />, "de");
    expect(de).toContain("Keine Rechte");
    expect(de).toContain("Dafür fehlen dir die Rechte. Frag eine Person mit Admin-Rolle.");
    const en = render(<ForbiddenState />, "en");
    expect(en).toContain("No rights");
    expect(en).toContain("You lack the rights for this. Ask a person with the Admin role.");
  });

  test("is a titled forbidden state inside the page, never a second page title or an action", () => {
    const html = render(<ForbiddenState />);
    expect(html).toContain('data-family-slot="data-state"');
    expect(html).toContain('data-family-state="forbidden"');
    expect(html).toContain('data-family-failure-kind="forbidden"');
    expect(html).toContain('data-testid="resource-permission-alert"');
    expect(html).not.toContain("data-family-surface");
    expect(html).not.toMatch(/<h[1-6][\s>]/);
    expect(html).not.toMatch(/<(a|button)[\s>]/);
  });

  test("every page renders a refused read through it, not as an empty list", () => {
    const src = join(import.meta.dir, "..");
    const files = [
      ...readdirSync(join(src, "pages")).map((file) => join(src, "pages", file)),
      ...readdirSync(join(src, "components/cockpit")).map((file) =>
        join(src, "components/cockpit", file),
      ),
    ].filter((file) => file.endsWith(".tsx") && !file.includes(".test."));
    const loose = files.filter((file) =>
      readFileSync(file, "utf8").includes("resource.permission."),
    );
    expect(loose).toEqual([]);
  });
});

describe("BootstrapErrorPage", () => {
  test("names an unreachable SubKit and offers retry in German and English", () => {
    const de = render(<BootstrapErrorPage onRetry={() => {}} />, "de");
    expect(de).toContain('data-testid="fatal-error"');
    expect(de).toContain('data-family-surface="fatal-error"');
    expect(de).toContain('role="alert"');
    expect(de).toMatch(/<h1[^>]*>SubKit ist gerade nicht erreichbar<\/h1>/);
    expect(de).toContain("Das Cockpit konnte nicht geladen werden. Versuche es erneut.");
    expect(de).toMatch(/<button\b[^>]*data-testid="session-retry"[^>]*>Erneut versuchen<\/button>/);
    expect(de.match(/<button\b/g)?.length).toBe(1);
    expect(de).not.toMatch(/<a\b/);

    const en = render(<BootstrapErrorPage onRetry={() => {}} />, "en");
    expect(en).toMatch(/<h1[^>]*>SubKit is currently unreachable<\/h1>/);
    expect(en).toContain("The cockpit could not be loaded. Try again.");
    expect(en).toMatch(/<button\b[^>]*data-testid="session-retry"[^>]*>Try again<\/button>/);
  });

  test("retry invokes the supplied callback once", async () => {
    if (process.env.SUBKIT_FAILURE_STATE_RETRY_DOM_CHILD !== "1") {
      const child = Bun.spawnSync(
        [process.execPath, "test", import.meta.path, "-t", "retry invokes the supplied callback"],
        {
          env: { ...process.env, SUBKIT_FAILURE_STATE_RETRY_DOM_CHILD: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
      return;
    }

    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: "http://localhost",
      pretendToBeVisual: true,
    });
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
    const { createRoot } = await import("react-dom/client");
    let root: Root | undefined;
    const onRetry = mock(() => {});
    try {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      await act(async () => {
        root?.render(
          <I18nContext.Provider value={i18nValue()}>
            <TooltipProvider>
              <BootstrapErrorPage onRetry={onRetry} />
            </TooltipProvider>
          </I18nContext.Provider>,
        );
      });
      const button = dom.window.document.querySelector('[data-testid="session-retry"]');
      expect(button).not.toBeNull();
      await act(async () => {
        (button as HTMLButtonElement).click();
      });
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      if (root) await act(async () => root?.unmount());
      dom.window.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
});

describe("SessionExpiredPage", () => {
  test("explains the expired session and preserves the current Cockpit route on sign-in", () => {
    const href = loginHref({
      pathname: "/cockpit/workflows",
      search: "?status=active&category=sales",
    });
    expect(href).toBe(
      "/v1/identity/cockpit-login?return_to=%2Fcockpit%2Fworkflows%3Fstatus%3Dactive%26category%3Dsales",
    );

    const de = render(<SessionExpiredPage href={href} />, "de");
    expect(de).toMatch(/<h1[^>]*>Deine Sitzung ist abgelaufen<\/h1>/);
    expect(de).toContain("Melde dich erneut an, um fortzufahren.");
    const deAction =
      de.match(/<a\b[^>]*data-testid="session-expired-sign-in"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(deAction).toContain(`href="${href}"`);
    expect(deAction).toContain(">Neu anmelden</a>");
    expect(de.match(/<a\b/g)?.length).toBe(1);

    const en = render(<SessionExpiredPage href={href} />, "en");
    expect(en).toMatch(/<h1[^>]*>Your session has expired<\/h1>/);
    expect(en).toContain("Sign in again to continue.");
    const enAction =
      en.match(/<a\b[^>]*data-testid="session-expired-sign-in"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(enAction).toContain(`href="${href}"`);
    expect(enAction).toContain(">Sign in again</a>");
    expect(en.match(/<a\b/g)?.length).toBe(1);
  });
});

describe("NotFoundPage", () => {
  test("names the missing Cockpit page and exposes only the overview link", () => {
    const de = render(<NotFoundPage />, "de");
    expect(de).toContain('data-testid="not-found"');
    expect(de).toMatch(/<h1[^>]*>Diese Seite gibt es nicht<\/h1>/);
    expect(de).toContain("Diese Adresse gehört nicht zum aktuellen Cockpit.");
    expect(de.match(/<a\b/g)?.length).toBe(1);
    const deHome = de.match(/<a\b[^>]*data-testid="not-found-home"[^>]*>Zur Übersicht<\/a>/)?.[0];
    expect(deHome).toContain('href="/cockpit"');

    const en = render(<NotFoundPage />, "en");
    expect(en).toMatch(/<h1[^>]*>This page does not exist<\/h1>/);
    expect(en).toContain("This address is not part of the current cockpit.");
    expect(en.match(/<a\b/g)?.length).toBe(1);
    const enHome = en.match(/<a\b[^>]*data-testid="not-found-home"[^>]*>To the overview<\/a>/)?.[0];
    expect(enHome).toContain('href="/cockpit"');
  });
});
