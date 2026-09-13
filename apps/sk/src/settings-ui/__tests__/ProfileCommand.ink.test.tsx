// Verifies /profile opens a SinglePane (sk profile) and not the
// SettingsModal — see ProfileCommand.tsx and ink-app.tsx wiring.

import { describe, expect, mock, test } from "bun:test";

import type { EngineClient } from "../../engine-client.ts";
import { renderInk } from "../../tests/helpers/ink.tsx";
import { ProfileCommand } from "../ProfileCommand.tsx";

function stubClient(opts: { email?: string } = {}): EngineClient {
  return {
    skBootstrap: mock(async () => ({
      whoami: {
        id: "u1",
        kind: "user" as const,
        tenant_id: "t1",
        tenant_slug: "acme",
        email: opts.email ?? "alice@acme.test",
        role_name: "admin",
        provider: "workforce",
        base_url: "http://localhost:3000",
        scopes: null,
      },
      permissions: [],
      permissions_checked: [],
      tenant: { id: "t1", slug: "acme", display_name: null },
      recent_sessions: [],
      flags: {},
      server_time: "2024-11-14T22:13:20.000Z",
    })),
  } as unknown as EngineClient;
}

describe("ProfileCommand — /profile SinglePane", () => {
  test("title is `sk profile`", async () => {
    const ui = renderInk(<ProfileCommand client={stubClient()} onDismiss={() => undefined} />);
    try {
      await ui.waitFor((t) => t.includes("sk profile"));
      const txt = ui.text();
      expect(txt).toContain("sk profile");
      expect(txt).not.toMatch(/^sk settings/m);
    } finally {
      ui.unmount();
    }
  });

  test("body renders the identity card from skBootstrap", async () => {
    const ui = renderInk(
      <ProfileCommand
        client={stubClient({ email: "alice@acme.test" })}
        onDismiss={() => undefined}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("alice@acme.test"));
      const txt = ui.text();
      expect(txt).toContain("alice@acme.test");
      expect(txt).toContain("acme");
      expect(txt).toContain("admin");
    } finally {
      ui.unmount();
    }
  });

  test("Esc dismisses → onDismiss called", async () => {
    const dismissed: true[] = [];
    const ui = renderInk(
      <ProfileCommand
        client={stubClient()}
        onDismiss={() => {
          dismissed.push(true);
        }}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("sk profile"));
      await ui.press("esc");
      await ui.waitFor(() => dismissed.length > 0, { tries: 50, sleepMs: 10 });
      expect(dismissed.length).toBe(1);
    } finally {
      ui.unmount();
    }
  });

  test("two-step Esc: first Esc closes the tenant picker, pane stays mounted", async () => {
    const dismissed: true[] = [];
    // Successful listIdentityTenants so the picker fully renders a row.
    const client = {
      skBootstrap: mock(async () => ({
        whoami: {
          id: "u1",
          kind: "user" as const,
          tenant_id: "t1",
          tenant_slug: "acme",
          email: "alice@acme.test",
          role_name: "admin",
          provider: "workforce",
          base_url: "http://localhost:3000",
          scopes: null,
        },
        permissions: [],
        permissions_checked: [],
        tenant: { id: "t1", slug: "acme", display_name: null },
        recent_sessions: [],
        flags: {},
        server_time: "2024-11-14T22:13:20.000Z",
      })),
      listIdentityTenants: mock(async () => ({
        items: [{ id: "t1", slug: "acme", display_name: null }],
      })),
    } as unknown as EngineClient;
    const ui = renderInk(
      <ProfileCommand
        client={client}
        onDismiss={() => {
          dismissed.push(true);
        }}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("sk profile"));
      await ui.waitFor((t) => t.includes("Start a new session"));
      // 't' opens the switcher; picker renders "Switch tenant" header
      // bold + the "↑/↓ navigate · Enter to switch · Esc to cancel" row.
      await ui.type("t");
      await ui.waitFor((t) => /Enter to switch/.test(t));
      // First Esc → switcher closes, pane stays. Wait for the picker
      // marker to disappear so we know tenantPickerOpen flipped + the
      // useEffect fired + SinglePane's innerActive resync'd to false.
      await ui.press("esc");
      await ui.waitFor((t) => !/Enter to switch/.test(t), { tries: 100, sleepMs: 10 });
      expect(dismissed.length).toBe(0);
      // Second Esc → pane dismisses.
      await ui.press("esc");
      await ui.waitFor(() => dismissed.length > 0, { tries: 100, sleepMs: 10 });
      expect(dismissed.length).toBe(1);
    } finally {
      ui.unmount();
    }
  });

  test("`n` triggers the new-session action", async () => {
    const fired: string[] = [];
    const ui = renderInk(
      <ProfileCommand
        client={stubClient()}
        onDismiss={() => undefined}
        onAction={(a) => {
          fired.push(a.kind);
        }}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("sk profile"));
      // ProfileTab renders Start a new session menu once bootstrap resolves.
      await ui.waitFor((t) => t.includes("Start a new session"));
      await ui.type("n");
      await ui.waitFor(() => fired.length > 0, { tries: 50, sleepMs: 10 });
      expect(fired).toContain("new-session");
    } finally {
      ui.unmount();
    }
  });
});
