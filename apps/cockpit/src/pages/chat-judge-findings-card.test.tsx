import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { render } from "@/components/cockpit/patterns/test-utils";
import { I18nContext } from "@/lib/i18n-context";
import { ChatJudgeFindingsCard } from "./chat-judge-findings-card";
import type { ChatInstruction, ChatJudgeFindings } from "./chat-preview-cards";

const CHILD_FLAG = "SUBKIT_JUDGE_FINDINGS_DOM_CHILD";

const findings: ChatJudgeFindings = {
  verdict: "partial",
  reason: "Der Workflow liefert nicht alle gewünschten Kennzahlen.",
  missing: [
    "Datum steht in UTC statt Europe/Berlin",
    "Betreff fehlt im Bericht",
    "Meilensteine fehlen",
  ],
  workflow: { id: "wf-1", label: "subkit-github-briefing" },
};

const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";

function card(disabled = false) {
  return (
    <ChatJudgeFindingsCard
      findings={findings}
      disabled={disabled}
      onInstruction={() => {}}
      testId="f"
    />
  );
}

test("the German card shows the verdict, the reason and one open row per missing entry", () => {
  const html = render(card(), "de");
  expect(html).toContain("Vorschau erfüllt das Ziel noch nicht");
  expect(tag(html, "f-verdict")).toContain('data-tone="warn"');
  expect(html).toContain("Teilweise");
  expect(html).toContain("Der Workflow liefert nicht alle gewünschten Kennzahlen.");
  expect(html).toContain("@subkit-github-briefing");
  for (const index of [0, 1, 2]) {
    expect(tag(html, `f-row-${index}`)).toContain('data-state="open"');
    expect(html).toContain(`f-row-${index}-details`);
  }
  expect(html.match(/Automatisch beheben/g)?.length).toBe(3);
  expect(html.match(/So lassen/g)?.length).toBe(3);
  expect(html).toContain("3 offene Empfehlungen");
  expect(html).toContain("Alle Empfehlungen übernehmen");
});

test("rows stack and buttons fill the width on narrow screens", () => {
  const html = render(card(), "de");
  const row = tag(html, "f-row-0");
  expect(row).toContain("flex-col");
  expect(row).toContain("sm:flex-row");
  expect(row).toContain("min-w-0");
  expect(tag(html, "f-row-0-text")).toContain("truncate");
  for (const id of ["f-row-0-fix", "f-row-0-keep", "f-fix-all"]) {
    expect(tag(html, id)).toContain("w-full");
    expect(tag(html, id)).toContain("sm:w-auto");
  }
});

test("a failed verdict uses the error tone and English copy", () => {
  const html = render(
    <ChatJudgeFindingsCard
      findings={{ ...findings, verdict: "failed", workflow: null }}
      disabled
      onInstruction={() => {}}
      testId="f"
    />,
    "en",
  );
  expect(html).toContain("Preview does not meet the goal");
  expect(tag(html, "f-verdict")).toContain('data-tone="error"');
  expect(html).toContain("Not met");
  expect(html).toContain("Fix automatically");
  expect(html).toContain("Leave as is");
  expect(html).toContain("Apply all recommendations");
  expect(tag(html, "f-row-0-fix")).toContain("disabled");
  expect(html).not.toContain("f-workflow");
});

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

isolated("fixing, keeping and applying all hand over only the open findings", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { i18nValue } = await import("@/components/cockpit/patterns/test-utils");
  const sent: ChatInstruction[] = [];
  const element = (id: string) =>
    dom.window.document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const click = async (id: string) => {
    await act(async () => {
      element(id)?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };
  let root: Root | undefined;
  try {
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    await act(async () => {
      root?.render(
        <I18nContext.Provider value={i18nValue("de")}>
          <TooltipProvider>
            <ChatJudgeFindingsCard
              findings={findings}
              disabled={false}
              onInstruction={(instruction) => sent.push(instruction)}
              testId="f"
            />
          </TooltipProvider>
        </I18nContext.Provider>,
      );
    });
    await click("f-row-0-fix");
    expect(sent).toEqual([
      {
        message:
          "Behebe diesen Befund der Vorschau in @subkit-github-briefing und prüfe die Vorschau danach erneut:\n- Datum steht in UTC statt Europe/Berlin",
        references: [{ type: "workflow", id: "wf-1", label: "subkit-github-briefing" }],
      },
    ]);
    expect(element("f-row-0")?.dataset.state).toBe("handed");
    expect(element("f-row-0-fix")).toBeNull();
    expect(element("f-row-0-state")?.textContent).toBe("An den Chat übergeben");

    await click("f-row-1-keep");
    expect(sent.length).toBe(1);
    expect(element("f-row-1")?.dataset.state).toBe("kept");
    expect(element("f-row-1-state")?.textContent).toBe("Belassen");
    expect(element("f-count")?.textContent).toBe("1 offene Empfehlung");

    await click("f-fix-all");
    expect(sent.length).toBe(2);
    expect(sent[1]?.message).toBe(
      "Behebe diesen Befund der Vorschau in @subkit-github-briefing und prüfe die Vorschau danach erneut:\n- Meilensteine fehlen",
    );
    expect(element("f-row-2")?.dataset.state).toBe("handed");
    expect(element("f-fix-all")).toBeNull();
    expect(element("f-count")?.textContent).toBe("Alle Empfehlungen bearbeitet");
  } finally {
    if (root) await act(async () => root?.unmount());
    dom.window.close();
  }
});
