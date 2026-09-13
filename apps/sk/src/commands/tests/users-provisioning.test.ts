// Unit tests for the user-provisioning CLI surface: the `createUser` /
// `createInvite` engine-client contracts (mocked HTTP) and the
// once-only invite banner formatter. Mirrors the HTTP-mock style of
// `init.test.ts` — no real engine, no disk.

import { describe, expect, test } from "bun:test";

import { EngineClient, type UserInviteIssuedWire } from "../../engine-client.ts";
import { formatInviteIssued, usersCommand } from "../users.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const cmd = usersCommand as unknown as {
  subCommands: Record<string, { meta: { name: string } }>;
};

describe("sk users — citty surface", () => {
  test("registers create + invite subcommands", () => {
    expect(cmd.subCommands.create).toBeDefined();
    expect(cmd.subCommands.invite).toBeDefined();
  });
});

describe("EngineClient.createUser", () => {
  test("POSTs email+role to /v1/identity/users", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const client = new EngineClient({
      engine_url: "http://engine.test",
      api_key: "k",
      fetchImpl: ((url: string, init?: RequestInit) => {
        captured = { url, init: init ?? {} };
        return Promise.resolve(
          jsonResponse(
            {
              id: "11111111-1111-1111-1111-111111111111",
              tenant_id: "22222222-2222-2222-2222-222222222222",
              email: "new@example.com",
              role: "member",
              status: "invited",
              created_at: "2026-06-26T00:00:00.000Z",
              updated_at: "2026-06-26T00:00:00.000Z",
            },
            201,
          ),
        );
      }) as unknown as typeof fetch,
    });

    const user = await client.createUser({ email: "new@example.com", role: "member" });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("http://engine.test/v1/identity/users");
    expect(String(captured!.init.method)).toBe("POST");
    const sent = JSON.parse(String(captured!.init.body)) as Record<string, unknown>;
    expect(sent.email).toBe("new@example.com");
    expect(sent.role).toBe("member");
    expect(user.email).toBe("new@example.com");
    expect(user.role).toBe("member");
  });
});

describe("EngineClient.createInvite", () => {
  test("POSTs to /v1/identity/users/{id}/invites and returns the plaintext token", async () => {
    let captured: { url: string } | null = null;
    const client = new EngineClient({
      engine_url: "http://engine.test",
      api_key: "k",
      fetchImpl: ((url: string) => {
        captured = { url };
        return Promise.resolve(
          jsonResponse(
            {
              id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              tenant_id: "22222222-2222-2222-2222-222222222222",
              user_id: "11111111-1111-1111-1111-111111111111",
              prefix: "wf_invite_abcd",
              scopes: ["*"],
              allowed_workflows: null,
              allowed_connectors: null,
              expires_at: "2026-06-27T00:00:00.000Z",
              redeemed_at: null,
              revoked_at: null,
              created_by: "33333333-3333-3333-3333-333333333333",
              created_at: "2026-06-26T00:00:00.000Z",
              plaintext_token: "wf_invite_abcd1234secret",
            },
            201,
          ),
        );
      }) as unknown as typeof fetch,
    });

    const invite = await client.createInvite("11111111-1111-1111-1111-111111111111", {
      ttl_minutes: 60,
    });
    expect(captured!.url).toBe(
      "http://engine.test/v1/identity/users/11111111-1111-1111-1111-111111111111/invites",
    );
    expect(invite.plaintext_token).toBe("wf_invite_abcd1234secret");
  });
});

describe("formatInviteIssued", () => {
  test("prints the token, the ready-to-paste join line, and the expiry", () => {
    const invite: UserInviteIssuedWire = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      tenant_id: "22222222-2222-2222-2222-222222222222",
      user_id: "11111111-1111-1111-1111-111111111111",
      prefix: "wf_invite_abcd",
      scopes: ["*"],
      allowed_workflows: null,
      allowed_connectors: null,
      expires_at: "2026-06-27T00:00:00.000Z",
      redeemed_at: null,
      revoked_at: null,
      created_by: null,
      created_at: "2026-06-26T00:00:00.000Z",
      plaintext_token: "wf_invite_abcd1234secret",
    };
    const banner = formatInviteIssued(invite);
    expect(banner).toContain("wf_invite_abcd1234secret");
    expect(banner).toContain("sk join --invite wf_invite_abcd1234secret");
    expect(banner).toContain("2026-06-27T00:00:00.000Z");
    expect(banner).toContain("11111111-1111-1111-1111-111111111111");
  });
});
