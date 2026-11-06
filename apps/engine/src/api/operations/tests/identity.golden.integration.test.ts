import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type Answer,
  type IdentityWorld,
  identityAuditTrail,
  normalizeIdentity,
  requestIdentity,
  seedIdentityWorld,
} from "./identity-golden-world.ts";

const GOLDEN_PATH = new URL("./fixtures/identity.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};

const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let w: IdentityWorld;

function record(name: string, value: unknown): void {
  actual[name] = normalizeIdentity(w, value);
  expect(actual[name]).toBe(golden[name] as string);
}

function http(method: string, path: string, body?: unknown, key?: string): Promise<Answer> {
  return requestIdentity(w, method, path, body, key);
}

function trail(actions: string[]): Promise<string[]> {
  return identityAuditTrail(w, actions);
}

beforeAll(async () => {
  w = await seedIdentityWorld();
});

afterAll(async () => {
  await w.ctx.cleanup();
});

describe("identity operations keep their HTTP responses byte for byte", () => {
  test("permission is checked before the body is validated on every gated identity route", async () => {
    const id = MISSING;
    const calls: [string, string, string, unknown?][] = [
      ["tenants.list", "GET", "/v1/identity/tenants"],
      ["tenants.get", "GET", `/v1/identity/tenants/${id}`],
      ["users.list", "GET", "/v1/identity/users"],
      ["users.get", "GET", `/v1/identity/users/${id}`],
      ["users.create", "POST", "/v1/identity/users", { email: 1 }],
      ["users.patch", "PATCH", `/v1/identity/users/${id}`, { role: 1 }],
      ["users.delete", "DELETE", `/v1/identity/users/${id}`],
      ["provider_identities.bind", "POST", `/v1/identity/users/${id}/provider-identities`, {}],
      ["invites.create", "POST", `/v1/identity/users/${id}/invites`, { ttl_minutes: "x" }],
      ["invites.list", "GET", "/v1/identity/invites"],
      ["invites.revoke", "DELETE", `/v1/identity/invites/${id}`],
      ["system_accounts.list", "GET", "/v1/identity/system-accounts"],
      ["system_accounts.create", "POST", "/v1/identity/system-accounts", { name: 1 }],
      ["system_accounts.delete", "DELETE", `/v1/identity/system-accounts/${id}`],
      ["api_keys.list", "GET", "/v1/identity/api-keys"],
      ["api_keys.issue", "POST", "/v1/identity/api-keys", { owner_kind: "nobody" }],
      ["api_keys.rotate", "POST", `/v1/identity/api-keys/${id}/rotate`, { overlap_minutes: -1 }],
      ["api_keys.revoke", "DELETE", `/v1/identity/api-keys/${id}`],
      ["portal_tokens.list", "GET", "/v1/identity/portal-tokens"],
      ["portal_tokens.issue", "POST", "/v1/identity/portal-tokens", { user_id: 1 }],
      ["portal_tokens.revoke", "DELETE", `/v1/identity/portal-tokens/${id}`],
    ];
    for (const [name, method, path, body] of calls) {
      record(`http.denied.${name}`, await http(method, path, body, w.deniedKey));
    }
    record("http.denied.audit", await trail(["policy.denied"]));
  });

  test("role policy denies a caller that holds the permission but not the admin role", async () => {
    const calls = (selfId: string): [string, string, string, unknown?][] => [
      ["tenants.list", "GET", "/v1/identity/tenants"],
      ["tenants.get", "GET", `/v1/identity/tenants/${w.ctx.tenantId}`],
      ["users.list", "GET", "/v1/identity/users"],
      ["users.get.other", "GET", `/v1/identity/users/${w.ctx.userId}`],
      ["users.get.self", "GET", `/v1/identity/users/${selfId}`],
      ["users.create", "POST", "/v1/identity/users", { email: "nope@test.local" }],
      ["users.patch.self", "PATCH", `/v1/identity/users/${selfId}`, { role: "admin" }],
      ["users.delete", "DELETE", `/v1/identity/users/${w.memberUserId}`],
      [
        "provider_identities.bind",
        "POST",
        `/v1/identity/users/${w.memberUserId}/provider-identities`,
        { provider_id: "corp", subject: "s-1" },
      ],
      ["invites.create", "POST", `/v1/identity/users/${w.memberUserId}/invites`, {}],
      ["invites.list", "GET", "/v1/identity/invites"],
      ["invites.revoke", "DELETE", `/v1/identity/invites/${MISSING}`],
      ["system_accounts.list", "GET", "/v1/identity/system-accounts"],
      ["system_accounts.create", "POST", "/v1/identity/system-accounts", { name: "x" }],
      ["system_accounts.delete", "DELETE", `/v1/identity/system-accounts/${w.ctx.systemAccountId}`],
      ["api_keys.list", "GET", "/v1/identity/api-keys"],
      [
        "api_keys.issue.other",
        "POST",
        "/v1/identity/api-keys",
        { owner_kind: "user", owner_id: w.memberUserId },
      ],
      ["api_keys.rotate.other", "POST", `/v1/identity/api-keys/${w.ctx.apiKeyId}/rotate`, {}],
      ["api_keys.revoke.other", "DELETE", `/v1/identity/api-keys/${w.ctx.apiKeyId}`],
      ["portal_tokens.list", "GET", "/v1/identity/portal-tokens"],
      [
        "portal_tokens.issue",
        "POST",
        "/v1/identity/portal-tokens",
        { user_id: "end-1", allowed_workflows: ["w"] },
      ],
      ["portal_tokens.revoke", "DELETE", `/v1/identity/portal-tokens/${MISSING}`],
    ];
    for (const [name, method, path, body] of calls(w.operatorUserId)) {
      record(`http.operator.${name}`, await http(method, path, body, w.operatorKey));
    }
    for (const [name, method, path, body] of calls(w.memberUserId)) {
      record(`http.member.${name}`, await http(method, path, body, w.memberKey));
    }
    record("http.policy.audit", await trail(["policy.denied"]));
  });

  test("self-introspection routes answer every authenticated caller", async () => {
    for (const [who, key] of [
      ["admin", w.ctx.apiKey],
      ["member", w.memberKey],
      ["denied", w.deniedKey],
    ] as const) {
      record(`http.whoami.${who}`, await http("GET", "/v1/identity/whoami", undefined, key));
      record(`http.sk_bootstrap.${who}`, await http("GET", "/v1/sk/bootstrap", undefined, key));
      record(
        `http.permissions.${who}`,
        await http(
          "GET",
          `/v1/identity/permissions?resource_type=connector&resource_id=${MISSING}`,
          undefined,
          key,
        ),
      );
    }
    record(
      "http.permissions.invalid",
      await http("GET", "/v1/identity/permissions?resource_type=workflow&resource_id=x"),
    );
    record("http.whoami.anonymous", await http("GET", "/v1/identity/whoami", undefined, "nope"));
  });

  test("tenants", async () => {
    record("http.tenants.list", await http("GET", "/v1/identity/tenants"));
    record("http.tenants.get", await http("GET", `/v1/identity/tenants/${w.ctx.tenantId}`));
    record(
      "http.tenants.get.foreign",
      await http("GET", `/v1/identity/tenants/${w.foreignTenantId}`),
    );
    record("http.tenants.get.invalid", await http("GET", "/v1/identity/tenants/not-a-uuid"));
  });

  test("users with the last-admin and role-escalation guards", async () => {
    record("http.users.list", await http("GET", "/v1/identity/users"));
    record("http.users.list.page", await http("GET", "/v1/identity/users?limit=1&offset=1"));
    record("http.users.list.product", await http("GET", "/v1/identity/users?product_id=shop"));
    record("http.users.list.invalid", await http("GET", "/v1/identity/users?product_id=Bad!"));
    record("http.users.get", await http("GET", `/v1/identity/users/${w.memberUserId}`));
    record("http.users.get.missing", await http("GET", `/v1/identity/users/${MISSING}`));
    record("http.users.get.foreign", await http("GET", `/v1/identity/users/${w.foreignUserId}`));
    record("http.users.get.invalid", await http("GET", "/v1/identity/users/not-a-uuid"));
    record(
      "http.users.get.self_member",
      await http("GET", `/v1/identity/users/${w.memberUserId}`, undefined, w.memberKey),
    );
    record(
      "http.users.patch.self_escalation",
      await http("PATCH", `/v1/identity/users/${w.memberUserId}`, { role: "admin" }, w.memberKey),
    );
    record("http.users.create.invalid", await http("POST", "/v1/identity/users", { email: "x" }));
    const created = await http("POST", "/v1/identity/users", {
      email: "created-identity@test.local",
      display_name: "Created",
    });
    record("http.users.create", created);
    record(
      "http.users.create.duplicate",
      await http("POST", "/v1/identity/users", { email: "created-identity@test.local" }),
    );
    const createdId = (created.body as { id: string }).id;
    record(
      "http.users.patch.role",
      await http("PATCH", `/v1/identity/users/${createdId}`, { role: "enduser" }),
    );
    record(
      "http.users.patch.profile",
      await http("PATCH", `/v1/identity/users/${createdId}`, { display_name: null }),
    );
    record("http.users.patch.empty", await http("PATCH", `/v1/identity/users/${createdId}`, {}));
    record(
      "http.users.patch.missing",
      await http("PATCH", `/v1/identity/users/${MISSING}`, { role: "member" }),
    );
    record(
      "http.users.patch.foreign",
      await http("PATCH", `/v1/identity/users/${w.foreignUserId}`, { role: "admin" }),
    );
    record(
      "http.users.patch.last_admin",
      await http("PATCH", `/v1/identity/users/${w.ctx.userId}`, { role: "member" }),
    );
    record(
      "http.users.delete.last_admin",
      await http("DELETE", `/v1/identity/users/${w.ctx.userId}`),
    );
    record("http.users.delete.missing", await http("DELETE", `/v1/identity/users/${MISSING}`));
    record(
      "http.users.delete.foreign",
      await http("DELETE", `/v1/identity/users/${w.foreignUserId}`),
    );
    record("http.users.delete", await http("DELETE", `/v1/identity/users/${createdId}`));
    record("http.users.get.deleted", await http("GET", `/v1/identity/users/${createdId}`));
    record("http.users.delete.again", await http("DELETE", `/v1/identity/users/${createdId}`));
  });

  test("provider identities without a configured provider", async () => {
    const path = `/v1/identity/users/${w.memberUserId}/provider-identities`;
    record("http.bind.invalid", await http("POST", path, { provider_id: "Bad", subject: " x" }));
    record(
      "http.bind.unavailable",
      await http("POST", path, { provider_id: "corp", subject: "s" }),
    );
    record(
      "http.bind.missing_user",
      await http("POST", `/v1/identity/users/${MISSING}/provider-identities`, {
        provider_id: "corp",
        subject: "s",
      }),
    );
  });

  test("invites", async () => {
    const path = `/v1/identity/users/${w.memberUserId}/invites`;
    const created = await http("POST", path, { scopes: ["workflow:read"], ttl_minutes: 60 });
    record("http.invites.create", created);
    record(
      "http.invites.create.unknown_scope",
      await http("POST", path, { scopes: ["nope:nope"] }),
    );
    record("http.invites.create.invalid", await http("POST", path, { ttl_minutes: 0 }));
    record(
      "http.invites.create.missing_user",
      await http("POST", `/v1/identity/users/${MISSING}/invites`, {}),
    );
    record(
      "http.invites.create.foreign_user",
      await http("POST", `/v1/identity/users/${w.foreignUserId}/invites`, {}),
    );
    record("http.invites.list", await http("GET", "/v1/identity/invites"));
    record("http.invites.list.pending", await http("GET", "/v1/identity/invites?status=pending"));
    record("http.invites.list.invalid", await http("GET", "/v1/identity/invites?status=nope"));
    const inviteId = (created.body as { id: string }).id;
    record("http.invites.revoke", await http("DELETE", `/v1/identity/invites/${inviteId}`));
    record("http.invites.revoke.again", await http("DELETE", `/v1/identity/invites/${inviteId}`));
    record("http.invites.revoke.missing", await http("DELETE", `/v1/identity/invites/${MISSING}`));
    record(
      "http.invites.revoke.foreign",
      await http("DELETE", `/v1/identity/invites/${w.foreignInviteId}`),
    );
    record("http.invites.list.revoked", await http("GET", "/v1/identity/invites?status=revoked"));
  });

  test("system accounts", async () => {
    record("http.system_accounts.list", await http("GET", "/v1/identity/system-accounts"));
    record(
      "http.system_accounts.list.page",
      await http("GET", "/v1/identity/system-accounts?limit=1&offset=5"),
    );
    record(
      "http.system_accounts.create.invalid",
      await http("POST", "/v1/identity/system-accounts", { name: "" }),
    );
    const created = await http("POST", "/v1/identity/system-accounts", {
      name: "ci-bot",
      description: "Runs CI",
    });
    record("http.system_accounts.create", created);
    const id = (created.body as { id: string }).id;
    record(
      "http.system_accounts.delete",
      await http("DELETE", `/v1/identity/system-accounts/${id}`),
    );
    record(
      "http.system_accounts.delete.again",
      await http("DELETE", `/v1/identity/system-accounts/${id}`),
    );
    record(
      "http.system_accounts.delete.foreign",
      await http("DELETE", `/v1/identity/system-accounts/${w.foreignSystemAccountId}`),
    );
  });

  test("api keys with scope issuance and self-service", async () => {
    const issued = await http("POST", "/v1/identity/api-keys", {
      owner_kind: "system_account",
      owner_id: w.ctx.systemAccountId,
      name: "ci",
      scopes: ["workflow:read"],
      allowed_workflows: ["w-1"],
      expires_at: "2031-01-02T03:04:05.000Z",
    });
    record("http.api_keys.issue", issued);
    record(
      "http.api_keys.issue.unknown_scope",
      await http("POST", "/v1/identity/api-keys", {
        owner_kind: "user",
        owner_id: w.ctx.userId,
        scopes: ["nope:nope"],
      }),
    );
    record(
      "http.api_keys.issue.missing_owner",
      await http("POST", "/v1/identity/api-keys", { owner_kind: "user", owner_id: MISSING }),
    );
    record(
      "http.api_keys.issue.foreign_owner",
      await http("POST", "/v1/identity/api-keys", {
        owner_kind: "user",
        owner_id: w.foreignUserId,
      }),
    );
    record(
      "http.api_keys.issue.invalid_expiry",
      await http("POST", "/v1/identity/api-keys", {
        owner_kind: "user",
        owner_id: w.ctx.userId,
        expires_at: "tomorrow",
      }),
    );
    const own = await http(
      "POST",
      "/v1/identity/api-keys",
      { owner_kind: "user", owner_id: w.operatorUserId, name: "mine" },
      w.operatorKey,
    );
    record("http.api_keys.issue.self_operator", own);
    record(
      "http.api_keys.issue.self_operator_exceeds",
      await http(
        "POST",
        "/v1/identity/api-keys",
        { owner_kind: "user", owner_id: w.operatorUserId, scopes: ["rbac:write"] },
        w.operatorKey,
      ),
    );
    record("http.api_keys.list", await http("GET", "/v1/identity/api-keys"));
    record(
      "http.api_keys.list.member",
      await http("GET", "/v1/identity/api-keys", undefined, w.memberKey),
    );
    record(
      "http.api_keys.list.operator",
      await http("GET", "/v1/identity/api-keys", undefined, w.operatorKey),
    );
    const ownId = (own.body as { id: string }).id;
    const rotated = await http(
      "POST",
      `/v1/identity/api-keys/${ownId}/rotate`,
      { overlap_minutes: 5 },
      w.operatorKey,
    );
    record("http.api_keys.rotate.self_operator", rotated);
    const issuedId = (issued.body as { id: string }).id;
    record(
      "http.api_keys.rotate.other_operator",
      await http("POST", `/v1/identity/api-keys/${issuedId}/rotate`, {}, w.operatorKey),
    );
    record(
      "http.api_keys.rotate",
      await http("POST", `/v1/identity/api-keys/${issuedId}/rotate`, {}),
    );
    record(
      "http.api_keys.rotate.missing",
      await http("POST", `/v1/identity/api-keys/${MISSING}/rotate`, {}),
    );
    record(
      "http.api_keys.rotate.foreign",
      await http("POST", `/v1/identity/api-keys/${w.foreignApiKeyId}/rotate`, {}),
    );
    record(
      "http.api_keys.rotate.invalid",
      await http("POST", `/v1/identity/api-keys/${issuedId}/rotate`, { overlap_minutes: 0 }),
    );
    const newId = (rotated.body as { new: { id: string } }).new.id;
    record(
      "http.api_keys.revoke.other_operator",
      await http("DELETE", `/v1/identity/api-keys/${issuedId}`, undefined, w.operatorKey),
    );
    record(
      "http.api_keys.revoke.self_operator",
      await http("DELETE", `/v1/identity/api-keys/${newId}`, undefined, w.operatorKey),
    );
    record("http.api_keys.revoke", await http("DELETE", `/v1/identity/api-keys/${issuedId}`));
    record(
      "http.api_keys.revoke.missing",
      await http("DELETE", `/v1/identity/api-keys/${MISSING}`),
    );
    record(
      "http.api_keys.revoke.foreign",
      await http("DELETE", `/v1/identity/api-keys/${w.foreignApiKeyId}`),
    );
  });

  test("portal tokens", async () => {
    const issued = await http("POST", "/v1/identity/portal-tokens", {
      user_id: "end-user-1",
      allowed_workflows: ["w-1"],
      ttl_minutes: 30,
    });
    record("http.portal_tokens.issue", issued);
    record(
      "http.portal_tokens.issue.invalid",
      await http("POST", "/v1/identity/portal-tokens", { user_id: "u", allowed_workflows: [] }),
    );
    record("http.portal_tokens.list", await http("GET", "/v1/identity/portal-tokens"));
    const id = (issued.body as { id: string }).id;
    record("http.portal_tokens.revoke", await http("DELETE", `/v1/identity/portal-tokens/${id}`));
    record(
      "http.portal_tokens.revoke.again",
      await http("DELETE", `/v1/identity/portal-tokens/${id}`),
    );
    record(
      "http.portal_tokens.revoke.missing",
      await http("DELETE", `/v1/identity/portal-tokens/${MISSING}`),
    );
    record(
      "http.portal_tokens.revoke.foreign",
      await http("DELETE", `/v1/identity/portal-tokens/${w.foreignPortalTokenId}`),
    );
  });

  test("every state change wrote its audit row", async () => {
    record(
      "http.audit",
      await trail([
        "user.created",
        "user.invited",
        "user.identity_linked",
        "user.role_changed",
        "user.profile_updated",
        "user.deleted",
        "user_invite.revoked",
        "system_account.created",
        "system_account.deleted",
        "api_key.issued",
        "api_key.rotated",
        "api_key.revoked",
        "portal_token.issued",
        "portal_token.revoked",
      ]),
    );
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
