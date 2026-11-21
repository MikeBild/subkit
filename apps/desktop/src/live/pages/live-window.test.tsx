import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "../../shared/i18n.ts";
import { dictionary } from "../../shared/i18n.ts";
import type { LiveView } from "../../shared/live-ipc.ts";
import { AT, BROWSER_SCRIPT, COMPUTER_SCRIPT } from "../../shared/local/live-view.fixture.ts";
import {
  INITIAL_LIVE,
  type LiveEvent,
  type LiveState,
  liveSnapshot,
  reduceLive,
  reduceLiveAll,
} from "../../shared/local/live-view-model.ts";
import { LiveWindow } from "./live-window.tsx";

const actions = { stop: () => {}, decide: () => {}, handBack: () => {}, close: () => {} };

function html(live: LiveState, view: LiveView = "window", locale: Locale = "de"): string {
  return renderToStaticMarkup(
    <LiveWindow
      state={{
        view,
        locale,
        dark: false,
        messages: dictionary(locale),
        live: liveSnapshot(live, AT),
      }}
      actions={actions}
    />,
  );
}

const asking = reduceLiveAll(INITIAL_LIVE, COMPUTER_SCRIPT);

describe("live window", () => {
  test("shows the app, the source, the timeline and the question", () => {
    const page = html(asking);
    expect(page).toContain("SubKit bedient „Numbers“");
    expect(page).toContain("Von dir im Chat gestartet");
    expect(page).toContain('data-testid="live-timeline"');
    expect(page).toContain("Öffnen · <span");
    expect(page).toContain("Erledigt");
    expect(page).toContain("Wartet auf dich");
    expect(page).toContain('data-testid="live-approval-approve"');
    expect(page).toContain("Numbers · Sichern · ~/Documents/Berichte/Rechnungen.numbers");
    expect(page).toContain('src="screenshot.png?v=1"');
    expect(page).toContain("⌘⇧⎋");
  });

  test("an expired question is no longer offered", () => {
    const page = renderToStaticMarkup(
      <LiveWindow
        state={{
          view: "window",
          locale: "de",
          dark: false,
          messages: dictionary("de"),
          live: liveSnapshot(asking, AT + 60 * 60_000),
        }}
        actions={actions}
      />,
    );
    expect(page).not.toContain("live-approval-approve");
  });

  test("a scheduled browser handover offers to hand back, in English", () => {
    const page = html(reduceLiveAll(INITIAL_LIVE, BROWSER_SCRIPT), "window", "en");
    expect(page).toContain("From your schedule");
    expect(page).toContain("https://portal.example-bank.de");
    expect(page).toContain('data-testid="live-hand-back"');
    expect(page).toContain("Your turn – sign in, then “Hand back to SubKit”");
  });

  test("stopped, lost, injection and private address states", () => {
    const running = reduceLive(asking, { type: "injection" } as LiveEvent);
    expect(html(running)).toContain("Die Seite enthält eine Anweisung. SubKit folgt ihr nicht.");
    const stopped = { ...asking, status: "stopped" as const, ask: null };
    const stoppedPage = html(stopped);
    expect(stoppedPage).toContain("Gestoppt. Spätere Schritte laufen nicht.");
    expect(stoppedPage).toMatch(/data-testid="live-stop"[^>]*disabled/);
    expect(html({ ...asking, status: "lost" })).toContain('data-testid="live-lost"');
    expect(html({ ...asking, status: "finished", ask: null, error: "privateSuggested" })).toContain(
      'data-testid="live-error"',
    );
  });

  test("the overlay pill names the app and offers stop", () => {
    const pill = html(asking, "overlay");
    expect(pill).toContain('data-testid="overlay-stop"');
    expect(pill).toContain("SubKit bedient „Numbers“");
    expect(pill).not.toContain("live-timeline");
  });
});
