import { expect, test } from "bun:test";
import { ConfigSchema } from "../schema.ts";
import { findLeafByPath } from "../walk.ts";

test("hosted signup stays off independently of self-hosted signup", () => {
  const config = ConfigSchema.parse({
    database: { url: "postgres://x" },
    auth: { enable_signup: true },
  });
  expect(config.auth.hosted.enabled).toBe(false);
  expect(config.auth.hosted.registration_enabled).toBe(false);
  expect(findLeafByPath("auth.hosted.enabled")?.meta.scope).toBe("global");
});

test("OIDC signup policy is explicit and optional for existing installations", () => {
  const provider = {
    protocol: "oidc",
    id: "browser",
    label: "Browser",
    issuer_url: "https://identity.example.test",
    client_id: "browser-client",
  };
  for (const signup_policy of [undefined, "existing_tenant", "invite_only", "self_service"]) {
    const parsed = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      auth: { providers: [{ ...provider, ...(signup_policy ? { signup_policy } : {}) }] },
    });
    expect(parsed.success).toBe(true);
  }
  expect(
    ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      auth: { providers: [{ ...provider, signup_policy: "anything" }] },
    }).success,
  ).toBe(false);
});
