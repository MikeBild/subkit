import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { openSheet } from "../../shared/browser-sheet-model.ts";
import { openDrop } from "../../shared/drop-model.ts";
import { dictionary, type Locale } from "../../shared/i18n.ts";
import { INITIAL_CAPTURE } from "../../shared/quick-capture-model.ts";
import type { ShellState, ShellView } from "../../shared/shell-ipc.ts";
import { captureHints, dropLead, translator } from "../lib/text.ts";
import { ShellApp } from "./ShellApp.tsx";

const actions = {
  sendNote: async () => {},
  place: async () => {},
  close: async () => {},
  reopenBrowser: async () => {},
};

const file = (name: string, size: number) => ({ name, size });

function state(
  view: ShellView,
  patch: Partial<ShellState> = {},
  locale: Locale = "de",
): ShellState {
  return {
    view,
    locale,
    platform: "darwin",
    dark: false,
    messages: dictionary(locale),
    online: true,
    capture: INITIAL_CAPTURE,
    drop: openDrop([file("Angebot.pdf", 240_000), file("Notizen.md", 1200)], "dock"),
    sheet: openSheet(
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=a&state=s",
    ),
    ...patch,
  };
}

const html = (value: ShellState) =>
  renderToStaticMarkup(<ShellApp state={value} actions={actions} />);

describe("shell texts", () => {
  test("fills shortcut, modifier and counts", () => {
    const de = translator(dictionary("de"));
    const en = translator(dictionary("en"));
    expect(captureHints(de, "darwin")).toEqual({
      hint: "⌥ Leertaste – SubKit schnell öffnen",
      keys: "⌘ ↩ sendet · Esc schließt",
    });
    expect(dropLead(de, 1)).toBe("Eine Datei ist angekommen.");
    expect(dropLead(de, 3)).toBe("3 Dateien sind angekommen.");
    expect(de("browser.reauthTitle", { name: "Google Workspace" })).toBe(
      "SubKit den Zugriff auf Google Workspace erlauben",
    );
    expect(captureHints(en, "win32").keys).toBe("Ctrl ↩ sends · Esc closes");
    expect(captureHints(de, "linux").hint).toBe("Strg + Alt + Leertaste – SubKit schnell öffnen");
    expect(captureHints(en, "darwin").hint).toBe("⌥ Space – open SubKit quickly");
  });
});

describe("quick capture", () => {
  test("renders only in its own window with the dummy's parts", () => {
    const out = html(state("capture"));
    expect(out).toContain('aria-label="Schnellnotiz"');
    expect(out).toContain("⌥ Leertaste – SubKit schnell öffnen");
    expect(out).toContain('placeholder="Was willst du festhalten?"');
    expect(out).toContain("⌘ ↩ sendet · Esc schließt");
    expect(out).toContain("In den Eingang");
    expect(out).not.toContain("Wohin damit?");
  });

  test("offline names it instead of the keys", () => {
    const out = html(state("capture", { online: false }));
    expect(out).toContain(">Offline<");
    expect(out).not.toContain("sendet");
  });

  test("a failed send is an alert", () => {
    const out = html(state("capture", { capture: { phase: "failed", itemId: null } }, "en"));
    expect(out).toContain('role="alert"');
    expect(out).toContain("Not sent. Try again.");
  });
});

describe("browser sheet", () => {
  test("shows lock and address without the query", () => {
    const out = html(state("sheet", {}, "en"));
    expect(out).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(out).not.toContain("client_id");
    expect(out).toContain("Allow SubKit to access accounts.google.com");
    expect(out).toContain("Allow access in browser");
    expect(out).toContain("Cancel");
  });

  test("names the connector once its name is known", () => {
    const sheet = openSheet("https://accounts.google.com/o/oauth2/v2/auth", "c1");
    if (!sheet) throw new Error("sheet");
    const out = html(state("sheet", { sheet: { ...sheet, connectorName: "Google Workspace" } }));
    expect(out).toContain("SubKit den Zugriff auf Google Workspace erlauben");
    expect(out).toContain("Zugriff im Browser erlauben");
    expect(out).not.toContain("Zugriff auf accounts.google.com");
  });

  test("a finished sign-in shows its outcome in one line", () => {
    const sheet = openSheet("https://idp.example/auth", "c1");
    if (!sheet) throw new Error("sheet");
    const ok = html(state("sheet", { sheet: { ...sheet, phase: "succeeded" } }));
    expect(ok).toContain("Verbunden. SubKit lädt neu …");
    expect(ok).not.toContain("Abbrechen");
    const failed = html(
      state(
        "sheet",
        { sheet: { ...sheet, phase: "failed", reason: "token_exchange_failed" } },
        "en",
      ),
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Sign-in failed. Try again.");
    expect(failed).toContain("token_exchange_failed");
  });
});

describe("drop sheet", () => {
  test("is a dialog that renders into a portal, not into the other windows", () => {
    expect(html(state("capture"))).not.toContain("Wohin damit?");
    expect(html(state("sheet"))).not.toContain("Wohin damit?");
  });
});
