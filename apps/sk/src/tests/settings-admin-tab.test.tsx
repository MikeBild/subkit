import { describe, expect, mock, test } from "bun:test";
import type { EngineClient } from "../engine-client.ts";
import { AdminTab } from "../settings-ui/tabs/AdminTab.tsx";
import { renderInk } from "./helpers/ink.tsx";

function makeClient(opts: {
  apiKeys?: Array<Record<string, unknown>>;
  portalTokens?: Array<Record<string, unknown>>;
}): {
  client: EngineClient;
  revokeApiKey: ReturnType<typeof mock>;
  revokePortalToken: ReturnType<typeof mock>;
} {
  const revokeApiKey = mock(async () => undefined);
  const revokePortalToken = mock(async () => undefined);
  const client = {
    skBootstrap: mock(async () => ({
      whoami: {
        id: "u1",
        kind: "user" as const,
        tenant_id: "t1",
        tenant_slug: "acme",
        email: "u@a.test",
        role_name: "admin",
        provider: "workforce",
        base_url: "http://localhost:3000",
        scopes: null,
      },
      permissions: ["audit:read", "rbac:read"],
      permissions_checked: [],
      tenant: { id: "t1", slug: "acme", display_name: null },
      recent_sessions: [],
      flags: {},
      server_time: "2024-11-14T22:13:20.000Z",
    })),
    listMcpTools: mock(async () => ({ items: [] })),
    listMcpPrompts: mock(async () => ({ items: [] })),
    listMcpResources: mock(async () => ({ items: [] })),
    tailAuditLog: mock(async () => ({ items: [] })),
    listSkills: mock(async () => ({ items: [] })),
    listKnowledgeSources: mock(async () => ({ items: [] })),
    listApiKeys: mock(async () => ({ items: opts.apiKeys ?? [] })),
    listPortalTokens: mock(async () => ({ items: opts.portalTokens ?? [] })),
    listRoles: mock(async () => ({ items: [] })),
    listSubscriptions: mock(async () => ({ items: [] })),
    listSystemAccounts: mock(async () => ({ items: [] })),
    listHooksInbound: mock(async () => ({ items: [] })),
    listNotificationChannels: mock(async () => ({ items: [] })),
    revokeApiKey,
    revokePortalToken,
  } as unknown as EngineClient;
  return { client, revokeApiKey, revokePortalToken };
}

describe("AdminTab — role-gated CRUD (M8)", () => {
  test("renders all 7 sub-tabs", async () => {
    const { client } = makeClient({});
    const ui = renderInk(<AdminTab client={client} />);
    try {
      await ui.waitFor((t) => t.includes("RBAC"));
      const txt = ui.text();
      expect(txt).toContain("RBAC");
      expect(txt).toContain("Subscriptions");
      expect(txt).toContain("API Keys");
      expect(txt).toContain("System Accounts");
      expect(txt).toContain("Hooks");
      expect(txt).toContain("Notifications");
      expect(txt).toContain("Portal Tokens");
    } finally {
      ui.unmount();
    }
  });

  test("`3` jumps to API Keys sub-tab", async () => {
    const { client } = makeClient({
      apiKeys: [{ id: "k1", name: "ci-bot", status: "active" }],
    });
    const ui = renderInk(<AdminTab client={client} />);
    try {
      await ui.waitFor((t) => t.includes("RBAC"));
      await ui.type("3");
      await ui.waitFor((t) => t.includes("ci-bot"));
      const txt = ui.text();
      expect(txt).toContain("API keys");
      expect(txt).toContain("c create");
      expect(txt).toContain("ci-bot");
    } finally {
      ui.unmount();
    }
  });

  test("API key revoke flow → revokeApiKey called + flash", async () => {
    const { client, revokeApiKey } = makeClient({
      apiKeys: [{ id: "k99", name: "deploy-bot", status: "active" }],
    });
    const { ApiKeysSubTab } = await import("../settings-ui/tabs/admin/ApiKeysSubTab.tsx");
    const ui = renderInk(<ApiKeysSubTab client={client} />);
    try {
      await ui.waitFor((t) => t.includes("deploy-bot"));
      await ui.type("x");
      await ui.waitFor((t) => t.includes('Revoke api key "deploy-bot"?'));
      await ui.type("1");
      await ui.waitFor(() => revokeApiKey.mock.calls.length > 0, { tries: 100, sleepMs: 5 });
      expect(revokeApiKey.mock.calls.length).toBe(1);
      expect(revokeApiKey.mock.calls[0]?.[0]).toBe("k99");
      await ui.waitFor((t) => t.includes("revoked deploy-bot"));
    } finally {
      ui.unmount();
    }
  });

  test("API key create form → issueApiKey called and secret rendered (G9 closure)", async () => {
    const issueApiKey = mock(async () => ({
      id: "k-new",
      plaintext_token: "secret_AAA",
      prefix: "sk_",
    }));
    const { client: baseClient } = makeClient({});
    const client = { ...baseClient, issueApiKey } as unknown as EngineClient;

    const { ApiKeysSubTab } = await import("../settings-ui/tabs/admin/ApiKeysSubTab.tsx");
    const ui = renderInk(<ApiKeysSubTab client={client} />);
    try {
      await ui.waitFor((t) => t.includes("API keys"));
      await ui.type("c");
      await ui.waitFor((t) => t.includes("Issue API key"));
      for (const ch of "11111111-2222-3333-4444-555555555555") await ui.type(ch);
      await ui.press("down");
      for (const ch of "user") await ui.type(ch);
      await ui.press("enter");
      await ui.waitFor(() => issueApiKey.mock.calls.length > 0, { tries: 100, sleepMs: 5 });
      expect(issueApiKey.mock.calls.length).toBe(1);
      const args0 = issueApiKey.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(args0[0]).toMatchObject({
        owner_id: "11111111-2222-3333-4444-555555555555",
        owner_kind: "user",
      });
      await ui.waitFor((t) => t.includes("secret_AAA"));
      expect(ui.text()).toContain("New api key");
    } finally {
      ui.unmount();
    }
  });

  test("Portal token revoke flow → revokePortalToken called", async () => {
    const { client, revokePortalToken } = makeClient({
      portalTokens: [{ id: "p1", label: "ipad", expires_at: "2030-01-01T00:00:00Z" }],
    });
    const ui = renderInk(<AdminTab client={client} />);
    try {
      await ui.waitFor((t) => t.includes("RBAC"));
      await ui.type("7");
      await ui.waitFor((t) => t.includes("ipad"));
      await ui.type("x");
      await ui.waitFor((t) => t.includes('Revoke portal token "ipad"?'));
      await ui.type("1");
      await ui.waitFor(() => revokePortalToken.mock.calls.length > 0, {
        tries: 50,
        sleepMs: 5,
      });
      expect(revokePortalToken.mock.calls.length).toBe(1);
      expect(revokePortalToken.mock.calls[0]?.[0]).toBe("p1");
    } finally {
      ui.unmount();
    }
  });
});
