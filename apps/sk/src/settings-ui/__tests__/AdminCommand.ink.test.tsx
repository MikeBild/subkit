import { describe, expect, mock, test } from "bun:test";
import type { EngineClient } from "../../engine-client.ts";
import { renderInk } from "../../tests/helpers/ink.tsx";
import { AdminCommand } from "../AdminCommand.tsx";

function makeClient(opts: { permissions?: string[] } = {}): EngineClient {
  return {
    skBootstrap: mock(async () => ({
      whoami: {
        id: "u1",
        kind: "user" as const,
        tenant_id: "t1",
        tenant_slug: "acme",
        email: "u@a.test",
        role_name: opts.permissions?.length ? "admin" : "member",
        provider: "workforce",
        base_url: "http://localhost:3000",
        scopes: null,
      },
      permissions: opts.permissions ?? [],
      permissions_checked: [],
      tenant: { id: "t1", slug: "acme", display_name: null },
      recent_sessions: [],
      flags: {},
      server_time: "2024-11-14T22:13:20.000Z",
    })),
    listApiKeys: mock(async () => ({ items: [] })),
    listPortalTokens: mock(async () => ({ items: [] })),
    listRoles: mock(async () => ({ items: [] })),
    listSubscriptions: mock(async () => ({ items: [] })),
    listSystemAccounts: mock(async () => ({ items: [] })),
    listHooksInbound: mock(async () => ({ items: [] })),
    listNotificationChannels: mock(async () => ({ items: [] })),
  } as unknown as EngineClient;
}

describe("AdminCommand — /admin SinglePane", () => {
  test("title is `sk admin`", async () => {
    const ui = renderInk(
      <AdminCommand
        client={makeClient({ permissions: ["rbac:read"] })}
        onDismiss={() => undefined}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("sk admin"));
      const txt = ui.text();
      expect(txt).toContain("sk admin");
      expect(txt).not.toMatch(/^sk settings/m);
    } finally {
      ui.unmount();
    }
  });

  test("admin gate passes → renders AdminTab sub-tabs", async () => {
    const ui = renderInk(
      <AdminCommand
        client={makeClient({ permissions: ["rbac:read"] })}
        onDismiss={() => undefined}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("RBAC"));
      const txt = ui.text();
      expect(txt).toContain("RBAC");
      expect(txt).toContain("API Keys");
      expect(txt).toContain("Portal Tokens");
    } finally {
      ui.unmount();
    }
  });

  test("admin gate fails → renders 'no admin permissions' message", async () => {
    const ui = renderInk(
      <AdminCommand client={makeClient({ permissions: [] })} onDismiss={() => undefined} />,
    );
    try {
      await ui.waitFor((t) => t.includes("no admin permissions"));
      const txt = ui.text();
      expect(txt).toContain("no admin permissions");
      expect(txt).not.toContain("API Keys");
      expect(txt).not.toContain("Portal Tokens");
    } finally {
      ui.unmount();
    }
  });

  test("Esc dismisses → onDismiss called", async () => {
    const dismissed: true[] = [];
    const ui = renderInk(
      <AdminCommand
        client={makeClient({ permissions: ["rbac:read"] })}
        onDismiss={() => {
          dismissed.push(true);
        }}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("sk admin"));
      await ui.press("esc");
      await ui.waitFor(() => dismissed.length > 0, { tries: 50, sleepMs: 10 });
      expect(dismissed.length).toBe(1);
    } finally {
      ui.unmount();
    }
  });
});
