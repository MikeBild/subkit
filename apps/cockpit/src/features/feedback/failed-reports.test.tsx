import { describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { i18nValue, render } from "@/components/cockpit/patterns/test-utils";
import { I18nContext } from "@/lib/i18n-context";
import type { FailedReport } from "./failed-model";
import { FailedReports } from "./failed-reports";

const report = (over: Partial<FailedReport>): FailedReport => ({
  id: "r1",
  failure: "conflict",
  excerpt: "Export bricht ab",
  created_on_device_at: "2026-11-20T10:00:00.000Z",
  canResend: true,
  ...over,
});

const reports = [
  report({}),
  report({ id: "r2", failure: "too_large", excerpt: "Screenshot dabei", canResend: false }),
];

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("failed feedback reports", () => {
  test("nothing failed renders nothing", () => {
    expect(render(<FailedReports reports={[]} onResend={() => {}} onDiscard={() => {}} />)).toBe(
      "",
    );
  });

  test("one list, each report with its reason once", () => {
    const html = render(
      <FailedReports reports={reports} onResend={() => {}} onDiscard={() => {}} />,
    );
    const words = text(html);
    expect(words).toContain("Nicht gesendet");
    expect(words).toContain("Export bricht ab");
    expect(words.split("Meldungs-ID schon vergeben")).toHaveLength(2);
    expect(words.split("Anhang zu groß")).toHaveLength(2);
    expect(html.match(/data-testid="feedback-unsent"/g)).toHaveLength(1);
  });

  test("send again only where the reason allows it, discard always", () => {
    const html = render(
      <FailedReports reports={reports} onResend={() => {}} onDiscard={() => {}} />,
    );
    expect(html).toContain('data-testid="feedback-unsent-0-resend"');
    expect(html).not.toContain('data-testid="feedback-unsent-1-resend"');
    expect(html).toContain('data-testid="feedback-unsent-0-discard"');
    expect(html).toContain('data-testid="feedback-unsent-1-discard"');
  });

  test("speaks English too", () => {
    const html = render(
      <FailedReports reports={reports} onResend={() => {}} onDiscard={() => {}} />,
      "en",
    );
    expect(text(html)).toContain("Not sent");
    expect(text(html)).toContain("Send again");
    expect(text(html)).toContain("Attachment too large");
  });

  test("the buttons hand the report id to the actions", async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: "http://localhost",
      pretendToBeVisual: true,
    });
    const globals: Record<string, unknown> = {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node,
      Event: dom.window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const saved = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const { createRoot } = await import("react-dom/client");
    let root: Root | undefined;
    const onResend = mock((_id: string) => {});
    const onDiscard = mock((_id: string) => {});
    try {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      await act(async () => {
        root?.render(
          <I18nContext.Provider value={i18nValue()}>
            <FailedReports reports={reports} onResend={onResend} onDiscard={onDiscard} />
          </I18nContext.Provider>,
        );
      });
      const click = async (testId: string) => {
        const button = dom.window.document.querySelector(`[data-testid="${testId}"]`);
        expect(button).not.toBeNull();
        await act(async () => {
          (button as HTMLButtonElement).click();
        });
      };
      await click("feedback-unsent-0-resend");
      await click("feedback-unsent-1-discard");
      expect(onResend.mock.calls).toEqual([["r1"]]);
      expect(onDiscard.mock.calls).toEqual([["r2"]]);
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
