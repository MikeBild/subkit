// Verifies /permissions opens a SinglePane (sk permissions) and not the
// SettingsModal — see PermissionsCommand.tsx and ink-app.tsx wiring.

import { describe, expect, mock, test } from "bun:test";

import type { EngineClient } from "../../engine-client.ts";
import { renderInk } from "../../tests/helpers/ink.tsx";
import { PermissionsCommand } from "../PermissionsCommand.tsx";

function stubClient(): EngineClient {
  return {
    listSettings: mock(async () => ({
      items: [],
      diagnostics: { pending_restart_keys: [], override_keys: [] },
    })),
    setSetting: mock(async () => ({ value: "ask", requiresRestart: false })),
  } as unknown as EngineClient;
}

describe("PermissionsCommand — /permissions SinglePane", () => {
  test("title is `sk permissions` (not `sk settings`)", async () => {
    const ui = renderInk(<PermissionsCommand client={stubClient()} onDismiss={() => undefined} />);
    try {
      await ui.waitFor((t) => t.includes("sk permissions"));
      const txt = ui.text();
      expect(txt).toContain("sk permissions");
      expect(txt).not.toMatch(/^sk settings/m);
    } finally {
      ui.unmount();
    }
  });

  test("body renders PermissionsTab (radio with 4 options)", async () => {
    const ui = renderInk(<PermissionsCommand client={stubClient()} onDismiss={() => undefined} />);
    try {
      await ui.waitFor((t) => t.includes("Permission mode"));
      const txt = ui.text();
      expect(txt).toContain("Default");
      expect(txt).toContain("Auto-review");
      expect(txt).toContain("Plan only");
      expect(txt).toContain("Full Access");
    } finally {
      ui.unmount();
    }
  });

  test("Esc dismisses the pane → onDismiss called", async () => {
    const dismissed: true[] = [];
    const ui = renderInk(
      <PermissionsCommand
        client={stubClient()}
        onDismiss={() => {
          dismissed.push(true);
        }}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("sk permissions"));
      await ui.press("esc");
      // The SinglePane's useInput fires synchronously on the press.
      await ui.waitFor(() => dismissed.length > 0, { tries: 50, sleepMs: 10 });
      expect(dismissed.length).toBe(1);
    } finally {
      ui.unmount();
    }
  });

  test("tenant chip renders when tenant is set", async () => {
    const ui = renderInk(
      <PermissionsCommand client={stubClient()} tenant="acme" onDismiss={() => undefined} />,
    );
    try {
      await ui.waitFor((t) => t.includes("tenant: acme"));
      expect(ui.text()).toContain("tenant: acme");
    } finally {
      ui.unmount();
    }
  });
});
