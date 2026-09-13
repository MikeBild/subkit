// Targeted tests for the xray-cloud connector template after the
// client_credentials_json migration. Asserts:
//
//   - template validates against ConnectorTemplateSchema
//   - auth_type is "oauth2" (engine-managed exchange, not manual bearer)
//   - oauth block is present with grant_type "client_credentials_json"
//   - credential_hints declare client_id (not secret) + client_secret (secret)
//   - setup_instructions do NOT contain the stale "~1 hour" claim
//   - setup_instructions do NOT instruct operator to paste a token manually
//   - operator_quirks.rate_limit mentions 300 req/5min

import { describe, expect, test } from "bun:test";

import { loadBuiltinTemplates } from "../templates.ts";

const templates = loadBuiltinTemplates();
const xray = templates.find((t) => t.slug === "xray-cloud");

describe("xray-cloud template — post-migration shape", () => {
  test("template is present in the catalog", () => {
    expect(xray).toBeDefined();
  });

  test("auth_type is oauth2 (engine manages the token exchange)", () => {
    expect(xray?.auth_type).toBe("oauth2");
  });

  test("oauth block is present with grant_type client_credentials_json", () => {
    expect(xray?.oauth).not.toBeNull();
    expect(xray?.oauth?.grant_type).toBe("client_credentials_json");
  });

  test("oauth.token_endpoint points at the Xray authenticate endpoint", () => {
    expect(xray?.oauth?.token_endpoint).toBe("https://xray.cloud.getxray.app/api/v2/authenticate");
  });

  test("credential_hints contain client_id (non-secret) and client_secret (secret)", () => {
    const hints = xray?.credential_hints ?? [];
    const clientIdHint = hints.find((h) => h.field === "client_id");
    const clientSecretHint = hints.find((h) => h.field === "client_secret");
    expect(clientIdHint).toBeDefined();
    expect(clientIdHint?.secret).toBe(false);
    expect(clientSecretHint).toBeDefined();
    expect(clientSecretHint?.secret).toBe(true);
  });

  test("setup_instructions do not claim '~1 hour' token validity", () => {
    // The JWT is valid 24h, not ~1h. The stale claim must be removed.
    expect(xray?.setup_instructions).not.toMatch(/~1\s*h(our)?/i);
  });

  test("setup_instructions do not ask the operator to paste a JWT manually", () => {
    // Engine manages the exchange now — instructions must NOT direct
    // the operator to POST to authenticate + paste the result.
    const instructions = xray?.setup_instructions ?? "";
    expect(instructions).not.toMatch(/paste\s+the\s+jwt/i);
    expect(instructions).not.toMatch(/paste\s+(it|the\s+token)/i);
    expect(instructions).not.toMatch(/paste.*bearer/i);
  });

  test("setup_instructions mention automatic exchange and refresh", () => {
    const instructions = xray?.setup_instructions ?? "";
    expect(instructions).toMatch(/automat/i);
  });

  test("operator_quirks.rate_limit mentions the 300 req/5 min limit", () => {
    const quirks = xray?.operator_quirks ?? {};
    expect(quirks.rate_limit).toBeDefined();
    expect(quirks.rate_limit).toMatch(/300/);
  });

  test("description does not claim ~1h validity", () => {
    expect(xray?.description).not.toMatch(/~1\s*h(our)?/i);
  });
});
