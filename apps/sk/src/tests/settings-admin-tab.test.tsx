import { describe, expect, mock, test } from "bun:test";
import type { EngineClient } from "../engine-client.ts";
import {
  AdminTab,
  hookCreateBody,
  roleCreateBody,
  systemAccountCreateBody,
} from "../settings-ui/tabs/AdminTab.tsx";
import { issueApiKeyBody } from "../settings-ui/tabs/admin/ApiKeysSubTab.tsx";
import { issuePortalTokenBody } from "../settings-ui/tabs/admin/PortalTokensSubTab.tsx";
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
      apiKeys: [{ id: "k1", name: "ci-bot", revoked_at: null, last_used_at: null }],
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
      apiKeys: [{ id: "k99", name: "deploy-bot", revoked_at: null, last_used_at: null }],
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
      plaintext_key: "secret_AAA",
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
      portalTokens: [
        {
          id: "p1",
          enduser_ref: "u1",
          prefix: "ipad",
          revoked_at: null,
          expires_at: "2030-01-01T00:00:00Z",
        },
      ],
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

  test("API key list labels unnamed keys by id and marks revoked keys", async () => {
    const { client } = makeClient({
      apiKeys: [
        { id: "k-unnamed", name: null, revoked_at: null, last_used_at: "2026-01-02T03:04:05Z" },
        { id: "k-old", name: "old-bot", revoked_at: "2026-01-01T00:00:00Z", last_used_at: null },
      ],
    });
    const { ApiKeysSubTab } = await import("../settings-ui/tabs/admin/ApiKeysSubTab.tsx");
    const ui = renderInk(<ApiKeysSubTab client={client} />);
    try {
      await ui.waitFor((t) => t.includes("old-bot"));
      const txt = ui.text();
      expect(txt).toContain("k-unnamed [active] · last used 2026-01-02T03:04:05Z");
      expect(txt).toContain("old-bot [revoked]");
    } finally {
      ui.unmount();
    }
  });

  test("API key create form rejects an owner kind outside the contract", async () => {
    const issueApiKey = mock(async () => ({ id: "k-new", plaintext_key: "secret_AAA" }));
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
      for (const ch of "robot") await ui.type(ch);
      await ui.press("enter");
      await ui.waitFor((t) => t.includes("Owner kind must be user or system_account"));
      expect(issueApiKey.mock.calls.length).toBe(0);
    } finally {
      ui.unmount();
    }
  });

  test("Portal token list labels rows by prefix and marks expired tokens", async () => {
    const { client } = makeClient({
      portalTokens: [
        {
          id: "p-old",
          enduser_ref: "u1",
          prefix: "pt_old",
          revoked_at: null,
          expires_at: "2001-01-01T00:00:00Z",
        },
        {
          id: "p-gone",
          enduser_ref: "u1",
          prefix: "pt_gone",
          revoked_at: "2026-01-01T00:00:00Z",
          expires_at: "2030-01-01T00:00:00Z",
        },
      ],
    });
    const { PortalTokensSubTab } = await import("../settings-ui/tabs/admin/PortalTokensSubTab.tsx");
    const ui = renderInk(<PortalTokensSubTab client={client} />);
    try {
      await ui.waitFor((t) => t.includes("pt_gone"));
      const txt = ui.text();
      expect(txt).toContain("pt_old [expired] · exp 2001-01-01T00:00:00Z");
      expect(txt).toContain("pt_gone [revoked]");
    } finally {
      ui.unmount();
    }
  });

  test("Portal token create form sends the contract body and shows the plaintext token", async () => {
    const issuePortalToken = mock(async () => ({
      id: "p-new",
      prefix: "pt_new",
      plaintext_token: "portal_SECRET",
      expires_at: "2030-01-01T00:00:00Z",
    }));
    const { client: baseClient } = makeClient({});
    const client = { ...baseClient, issuePortalToken } as unknown as EngineClient;
    const { PortalTokensSubTab } = await import("../settings-ui/tabs/admin/PortalTokensSubTab.tsx");
    const ui = renderInk(<PortalTokensSubTab client={client} />);
    try {
      await ui.waitFor((t) => t.includes("Portal tokens"));
      await ui.type("c");
      await ui.waitFor((t) => t.includes("Issue portal token"));
      for (const ch of "u-42") await ui.type(ch);
      await ui.press("down");
      for (const ch of "wf-a, wf-b") await ui.type(ch);
      await ui.press("down");
      for (const ch of "30") await ui.type(ch);
      await ui.press("enter");
      await ui.waitFor(() => issuePortalToken.mock.calls.length > 0, { tries: 100, sleepMs: 5 });
      const args0 = issuePortalToken.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(args0[0]).toEqual({
        user_id: "u-42",
        allowed_workflows: ["wf-a", "wf-b"],
        ttl_minutes: 30,
      });
      await ui.waitFor((t) => t.includes("portal_SECRET"));
      expect(ui.text()).toContain("New portal token");
    } finally {
      ui.unmount();
    }
  });

  test("System account create form offers a description instead of a role id", async () => {
    const { client } = makeClient({});
    const ui = renderInk(<AdminTab client={client} />);
    try {
      await ui.waitFor((t) => t.includes("RBAC"));
      await ui.type("4");
      await ui.waitFor((t) => t.includes("System accounts"));
      await ui.type("c");
      await ui.waitFor((t) => t.includes("Create system account"));
      const txt = ui.text();
      expect(txt).toContain("Description");
      expect(txt).not.toContain("Role id");
    } finally {
      ui.unmount();
    }
  });

  test("Inbound hook create form asks for workflow id, verifier and secret", async () => {
    const { client } = makeClient({});
    const ui = renderInk(<AdminTab client={client} />);
    try {
      await ui.waitFor((t) => t.includes("RBAC"));
      await ui.type("5");
      await ui.waitFor((t) => t.includes("Hooks (inbound)"));
      await ui.type("c");
      await ui.waitFor((t) => t.includes("Create inbound hook"));
      const txt = ui.text();
      expect(txt).toContain("Workflow id*");
      expect(txt).toContain("Verifier*");
      expect(txt).toContain("standard | github | stripe | hmac | custom");
      expect(txt).toContain("HMAC secret*");
    } finally {
      ui.unmount();
    }
  });
});

describe("AdminTab — request bodies follow the engine contract", () => {
  test("role body sends name and only a non-blank description", () => {
    expect(roleCreateBody({ name: "ops", description: "  " })).toEqual({ name: "ops" });
    expect(roleCreateBody({ name: "ops", description: " read only " })).toEqual({
      name: "ops",
      description: "read only",
    });
    expect(roleCreateBody({})).toEqual({ name: "" });
  });

  test("system account body carries name and description, never role_id", () => {
    expect(systemAccountCreateBody({ name: "ci", role_id: "r1" })).toEqual({ name: "ci" });
    expect(systemAccountCreateBody({ name: "ci", description: "deployer" })).toEqual({
      name: "ci",
      description: "deployer",
    });
  });

  test("inbound hook body requires a verifier from the contract enum", () => {
    expect(
      hookCreateBody({ slug: "stripe", workflow_id: " wf-1 ", verifier: "stripe", secret: " s " }),
    ).toEqual({ slug: "stripe", workflow_id: "wf-1", verifier: "stripe", secret: "s" });
    expect(() =>
      hookCreateBody({ slug: "x", workflow_id: "w", verifier: "svix", secret: "s" }),
    ).toThrow("Verifier must be one of standard | github | stripe | hmac | custom");
  });

  test("api key body parses scopes, keeps expires_at and checks owner_kind", () => {
    expect(
      issueApiKeyBody({
        owner_id: "u1",
        owner_kind: "system_account",
        scopes: "rbac:read, ,audit:read",
        expires_at: " 2026-12-31T00:00:00Z ",
      }),
    ).toEqual({
      owner_id: "u1",
      owner_kind: "system_account",
      scopes: ["rbac:read", "audit:read"],
      expires_at: "2026-12-31T00:00:00Z",
    });
    expect(issueApiKeyBody({ owner_id: "u1", owner_kind: "user", scopes: " " })).toEqual({
      owner_id: "u1",
      owner_kind: "user",
    });
    expect(() => issueApiKeyBody({ owner_id: "u1", owner_kind: "" })).toThrow(
      "Owner kind must be user or system_account",
    );
  });

  test("portal token body drops a ttl that is not a positive integer", () => {
    expect(
      issuePortalTokenBody({ user_id: "u1", allowed_workflows: "a", ttl_minutes: "0" }),
    ).toEqual({ user_id: "u1", allowed_workflows: ["a"] });
    expect(issuePortalTokenBody({ user_id: "u1" })).toEqual({
      user_id: "u1",
      allowed_workflows: [],
    });
  });
});
