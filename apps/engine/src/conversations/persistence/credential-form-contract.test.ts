import { describe, expect, it } from "bun:test";
import type { Db } from "../../db/client.ts";
import {
  CREDENTIAL_FORM_FIELDS,
  credentialModeMatchesAuthType,
  resolveDraftCredentialSeedMode,
  validateCredentialFormFields,
} from "./credential-form-contract.ts";

const stubDb = {} as unknown as Db;

describe("validateCredentialFormFields — per-mode contracts", () => {
  it("accepts the canonical bearer form", () => {
    expect(validateCredentialFormFields({ seedMode: "bearer", fieldNames: ["token"] })).toEqual({
      ok: true,
    });
  });

  it("rejects the literal `basic_auth` single-field repro on a basic draft", () => {
    const verdict = validateCredentialFormFields({
      seedMode: "basic",
      fieldNames: ["basic_auth"],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.missing.sort()).toEqual(["password", "username"]);
      expect(verdict.message).toContain("[username, password]");
      expect(verdict.message).toContain("base64");
    }
  });

  it("rejects a `token` field on a basic draft", () => {
    const verdict = validateCredentialFormFields({
      seedMode: "basic",
      fieldNames: ["token"],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.missing.sort()).toEqual(["password", "username"]);
  });

  it("accepts the canonical basic form", () => {
    expect(
      validateCredentialFormFields({ seedMode: "basic", fieldNames: ["username", "password"] }),
    ).toEqual({ ok: true });
  });

  it("header: a seeded header_name means the form only needs header_value", () => {
    expect(
      validateCredentialFormFields({
        seedMode: "header",
        fieldNames: ["header_value"],
        seededSlots: ["header_name"],
      }),
    ).toEqual({ ok: true });
    const without = validateCredentialFormFields({
      seedMode: "header",
      fieldNames: ["header_value"],
    });
    expect(without.ok).toBe(false);
    if (!without.ok) expect(without.missing).toEqual(["header_name"]);
  });

  it("query requires param + value", () => {
    expect(
      validateCredentialFormFields({ seedMode: "query", fieldNames: ["param", "value"] }),
    ).toEqual({ ok: true });
    expect(validateCredentialFormFields({ seedMode: "query", fieldNames: ["api_key"] }).ok).toBe(
      false,
    );
  });

  it("aws_sigv4 requires keys, session_token stays optional", () => {
    expect(
      validateCredentialFormFields({
        seedMode: "aws_sigv4",
        fieldNames: ["access_key_id", "secret_access_key"],
      }),
    ).toEqual({ ok: true });
    expect(
      validateCredentialFormFields({
        seedMode: "aws_sigv4",
        fieldNames: ["access_key_id", "secret_access_key", "session_token"],
      }),
    ).toEqual({ ok: true });
  });

  it("cognito_user_password requires username + password; region/client come from config seeds", () => {
    expect(
      validateCredentialFormFields({
        seedMode: "cognito_user_password",
        fieldNames: ["username", "password"],
        seededSlots: ["aws_region", "client_id"],
      }),
    ).toEqual({ ok: true });
  });

  it("oauth2 requires client_id only (PKCE public clients omit the secret)", () => {
    expect(validateCredentialFormFields({ seedMode: "oauth2", fieldNames: ["client_id"] })).toEqual(
      { ok: true },
    );
    expect(
      validateCredentialFormFields({
        seedMode: "oauth2",
        fieldNames: ["client_id", "client_secret"],
      }),
    ).toEqual({ ok: true });
  });

  it("matches field names + seeded slots case-insensitively", () => {
    expect(
      validateCredentialFormFields({
        seedMode: "basic",
        fieldNames: ["Username", "PASSWORD"],
      }),
    ).toEqual({ ok: true });
    expect(
      validateCredentialFormFields({
        seedMode: "header",
        fieldNames: ["Header_Value"],
        seededSlots: ["HEADER_NAME"],
      }),
    ).toEqual({ ok: true });
  });

  it("validates ok for an unknown seed mode — never blocks a future auth shape", () => {
    expect(validateCredentialFormFields({ seedMode: "kerberos", fieldNames: ["ticket"] })).toEqual({
      ok: true,
    });
  });

  it("every table entry round-trips its own required names", () => {
    for (const [mode, contract] of Object.entries(CREDENTIAL_FORM_FIELDS)) {
      expect(
        validateCredentialFormFields({ seedMode: mode, fieldNames: [...contract.required] }),
      ).toEqual({ ok: true });
    }
  });
});

describe("credentialModeMatchesAuthType (moved from save-connector.ts)", () => {
  it("exact-mode matches for the classic modes", () => {
    expect(credentialModeMatchesAuthType("bearer", "bearer")).toBe(true);
    expect(credentialModeMatchesAuthType("basic", "basic")).toBe(true);
    expect(credentialModeMatchesAuthType("header", "header")).toBe(true);
    expect(credentialModeMatchesAuthType("query", "query")).toBe(true);
    expect(credentialModeMatchesAuthType("aws_sigv4", "aws_sigv4")).toBe(true);
  });

  it("rejects cross-mode pairs (the stale-cache symptom)", () => {
    expect(credentialModeMatchesAuthType("bearer", "basic")).toBe(false);
    expect(credentialModeMatchesAuthType("basic", "bearer")).toBe(false);
    expect(credentialModeMatchesAuthType("header", "query")).toBe(false);
  });

  it("oauth2 auth_type accepts both oauth2 and cognito_user_password modes", () => {
    expect(credentialModeMatchesAuthType("oauth2", "oauth2")).toBe(true);
    expect(credentialModeMatchesAuthType("cognito_user_password", "oauth2")).toBe(true);
    expect(credentialModeMatchesAuthType("bearer", "oauth2")).toBe(false);
  });
});

describe("resolveDraftCredentialSeedMode — db-free paths", () => {
  it("maps the four classic auth_types straight through", async () => {
    for (const authType of ["bearer", "basic", "header", "query"] as const) {
      const res = await resolveDraftCredentialSeedMode({
        connector: { auth_type: authType },
        db: stubDb,
        tenant_id: "t-1",
      });
      expect(res.seedMode).toBe(authType);
    }
  });

  it("routes oauth2 + cognito grant_type from draft config to cognito_user_password with seeds", async () => {
    const res = await resolveDraftCredentialSeedMode({
      connector: {
        auth_type: "oauth2",
        config: {
          aws_region: "eu-central-1",
          oauth: { client_id: "client-abc", grant_type: "cognito_user_password" },
        },
      },
      db: stubDb,
      tenant_id: "t-1",
    });
    expect(res.seedMode).toBe("cognito_user_password");
    expect(res.seedOverrides).toEqual({ aws_region: "eu-central-1", client_id: "client-abc" });
  });

  it("routes oauth2 + authorization_code / client_credentials to the BYO oauth2 seed", async () => {
    for (const grant of ["authorization_code", "client_credentials"]) {
      const res = await resolveDraftCredentialSeedMode({
        connector: { auth_type: "oauth2", config: { oauth: { grant_type: grant } } },
        db: stubDb,
        tenant_id: "t-1",
      });
      expect(res.seedMode).toBe("oauth2");
    }
  });

  it("routes an mcp oauth2 draft to the oauth2 seed and seeds its configured client id", async () => {
    const bare = await resolveDraftCredentialSeedMode({
      connector: {
        driver: "mcp",
        auth_type: "oauth2",
        config: { mcp: { auth: { kind: "oauth2" } } },
      },
      db: stubDb,
      tenant_id: "t-1",
    });
    expect(bare.seedMode).toBe("oauth2");
    expect(bare.seedOverrides).toEqual({});
    const configured = await resolveDraftCredentialSeedMode({
      connector: {
        driver: "mcp",
        auth_type: "oauth2",
        config: { mcp: { auth: { kind: "oauth2", client_id: "public-client" } } },
      },
      db: stubDb,
      tenant_id: "t-1",
    });
    expect(configured.seedOverrides).toEqual({ client_id: "public-client" });
  });

  it("routes oauth2 + password grant to the basic shape (RFC 6749 §4.3)", async () => {
    const res = await resolveDraftCredentialSeedMode({
      connector: { auth_type: "oauth2", config: { oauth: { grant_type: "password" } } },
      db: stubDb,
      tenant_id: "t-1",
    });
    expect(res.seedMode).toBe("basic");
  });

  it("tolerates a failing template lookup — falls back to the plain auth_type mapping", async () => {
    const res = await resolveDraftCredentialSeedMode({
      connector: {
        auth_type: "oauth2",
        template_slug: "some-template",
        config: { oauth: { grant_type: "authorization_code" } },
      },
      db: stubDb,
      tenant_id: "t-1",
    });
    expect(res.seedMode).toBe("oauth2");
    const sigv4 = await resolveDraftCredentialSeedMode({
      connector: { auth_type: "aws_sigv4", template_slug: "some-template" },
      db: stubDb,
      tenant_id: "t-1",
    });
    expect(sigv4.seedMode).toBe("aws_sigv4");
  });

  it("returns null for unsupported shapes (none / unknown grant / missing connector)", async () => {
    expect(
      (
        await resolveDraftCredentialSeedMode({
          connector: { auth_type: "none" },
          db: stubDb,
          tenant_id: "t-1",
        })
      ).seedMode,
    ).toBeNull();
    expect(
      (
        await resolveDraftCredentialSeedMode({
          connector: { auth_type: "oauth2", config: { oauth: { grant_type: "jwt-bearer" } } },
          db: stubDb,
          tenant_id: "t-1",
        })
      ).seedMode,
    ).toBeNull();
    expect(
      (await resolveDraftCredentialSeedMode({ connector: null, db: stubDb, tenant_id: "t-1" }))
        .seedMode,
    ).toBeNull();
  });
});
