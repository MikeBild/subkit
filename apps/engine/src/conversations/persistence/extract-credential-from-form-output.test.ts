// Pure-function tests for `extractCredentialFromFormOutput` — the
// adapter that turns an `ask_user_form` submission into the typed
// `AtomicCredentialInput` consumed by `saveConnectorAtomic`.
//
// Pre-fix the LLM frequently emitted `commit_intent.payload.credential
// = { mode: "oauth2" }` (matching the connector's `auth_type`) and the
// adapter fell through `default → null`. The connector saved without
// any credential row → 401 on every subsequent call. Reproduces the
// AppSync Cognito session bab50df1.

import { describe, expect, it } from "bun:test";

import { extractCredentialFromFormOutput } from "./auto-persist.ts";

describe("extractCredentialFromFormOutput — bearer / basic / header / query", () => {
  it("maps a bearer form into a bearer credential", () => {
    const out = extractCredentialFromFormOutput("bearer", {}, { values: { token: "tk_live_abc" } });
    expect(out).toEqual({ mode: "bearer", token: "tk_live_abc" });
  });

  it("strips a leading `Bearer ` scheme word from a bearer token", () => {
    // The HTTP driver emits `Authorization: Bearer ${token}` itself, so a
    // token that already carries the scheme would be double-prefixed to
    // `Bearer Bearer …` → 401 on a valid key. Accept the operator typing
    // (or pasting) the scheme and normalise it away — case-insensitively,
    // with any surrounding whitespace.
    expect(
      extractCredentialFromFormOutput("bearer", {}, { values: { token: "Bearer wf_live_abc123" } }),
    ).toEqual({ mode: "bearer", token: "wf_live_abc123" });
    expect(
      extractCredentialFromFormOutput(
        "bearer",
        {},
        { values: { token: "  bearer   wf_live_abc123 " } },
      ),
    ).toEqual({ mode: "bearer", token: "wf_live_abc123" });
  });

  it("keeps a pasted `Authorization: Bearer …` verbatim for header mode", () => {
    // header/query values are written to the wire verbatim — the scheme is
    // part of the header value there and must NOT be stripped.
    expect(
      extractCredentialFromFormOutput(
        "header",
        { header_name: "Authorization" },
        { values: { header_value: "Bearer wf_live_abc123" } },
      ),
    ).toEqual({
      mode: "header",
      header_name: "Authorization",
      header_value: "Bearer wf_live_abc123",
    });
  });

  it("maps a basic form (username + password) into a basic credential", () => {
    const out = extractCredentialFromFormOutput(
      "basic",
      {},
      { values: { username: "alice", password: "pw" } },
    );
    expect(out).toEqual({ mode: "basic", username: "alice", password: "pw" });
  });

  it("returns null when basic is missing the password", () => {
    expect(
      extractCredentialFromFormOutput("basic", {}, { values: { username: "alice" } }),
    ).toBeNull();
  });

  it("prefers an explicit username over an email decoy when both are present", () => {
    // `email` is accepted as a username alias (Atlassian-style forms), but an
    // explicit `username` field must win — an unrelated contact-email field
    // surfaced next to the credential must never be picked as the username.
    const out = extractCredentialFromFormOutput(
      "basic",
      {},
      { values: { username: "real", email: "decoy@x", password: "pw" } },
    );
    expect(out).toEqual({ mode: "basic", username: "real", password: "pw" });
  });

  it("uses seedOverrides as a fallback for header_name", () => {
    const out = extractCredentialFromFormOutput(
      "header",
      { header_name: "X-API-Key" },
      { values: { header_value: "secret" } },
    );
    expect(out).toEqual({ mode: "header", header_name: "X-API-Key", header_value: "secret" });
  });
});

describe("extractCredentialFromFormOutput — oauth2 → cognito routing", () => {
  it("promotes oauth2 → cognito_user_password when grant_type hint is set", () => {
    const out = extractCredentialFromFormOutput(
      "oauth2",
      { grant_type: "cognito_user_password" },
      { values: { username: "u@x.com", password: "pw" } },
    );
    expect(out?.mode).toBe("cognito_user_password");
    if (out?.mode === "cognito_user_password") {
      expect(out.username).toBe("u@x.com");
      expect(out.password).toBe("pw");
    }
  });

  it("promotes oauth2 → cognito_user_password when aws_region hint is present", () => {
    const out = extractCredentialFromFormOutput(
      "oauth2",
      { aws_region: "eu-central-1", client_id: "abc123" },
      { values: { username: "u@x.com", password: "pw" } },
    );
    expect(out?.mode).toBe("cognito_user_password");
    if (out?.mode === "cognito_user_password") {
      expect(out.aws_region).toBe("eu-central-1");
      expect(out.client_id).toBe("abc123");
    }
  });

  it("promotes oauth2 → cognito when cognito_client_id field name is used", () => {
    const out = extractCredentialFromFormOutput(
      "oauth2",
      { cognito_client_id: "xyz" },
      { values: { username: "u@x.com", password: "pw" } },
    );
    expect(out?.mode).toBe("cognito_user_password");
  });

  it("falls through to the BYO oauth2 branch when form provides client_id (no cognito hint)", () => {
    // Without cognito hints + with client_id present, the extractor
    // builds the AtomicCredentialInput.oauth2 seed — NOT cognito.
    // {username,password} values without a client_id mean the form
    // doesn't carry the right shape for the BYO oauth2 branch either,
    // so the result is null. See the "oauth2 BYO authorization_code"
    // describe block below for the positive case.
    const out = extractCredentialFromFormOutput(
      "oauth2",
      {},
      { values: { username: "u@x.com", password: "pw" } },
    );
    expect(out).toBeNull();
  });
});

describe("extractCredentialFromFormOutput — oauth2 BYO authorization_code", () => {
  it("returns oauth2 seed with client_id + client_secret from form values (gmail / google-* / msgraph BYO)", () => {
    const out = extractCredentialFromFormOutput(
      "oauth2",
      {},
      { values: { client_id: "client-abc", client_secret: "secret-xyz" } },
    );
    expect(out).toEqual({
      mode: "oauth2",
      client_id: "client-abc",
      client_secret: "secret-xyz",
    });
  });

  it("returns oauth2 seed with client_id only (PKCE public client, no secret)", () => {
    const out = extractCredentialFromFormOutput(
      "oauth2",
      {},
      { values: { client_id: "public-app-id" } },
    );
    expect(out).toEqual({ mode: "oauth2", client_id: "public-app-id" });
    if (out?.mode === "oauth2") {
      expect(out.client_secret).toBeUndefined();
    }
  });

  it("accepts client_id from seedOverrides + client_secret from form (template-provided client_id)", () => {
    const out = extractCredentialFromFormOutput(
      "oauth2",
      { client_id: "template-shared-id" },
      { values: { client_secret: "shh" } },
    );
    expect(out).toEqual({
      mode: "oauth2",
      client_id: "template-shared-id",
      client_secret: "shh",
    });
  });

  it("threads optional token_endpoint, authorization_endpoint, scopes through to the seed", () => {
    const out = extractCredentialFromFormOutput(
      "oauth2",
      {},
      {
        values: {
          client_id: "abc",
          client_secret: "shh",
          token_endpoint: "https://example.com/token",
          authorization_endpoint: "https://example.com/authorize",
          scopes: "read write",
        },
      },
    );
    expect(out?.mode).toBe("oauth2");
    if (out?.mode === "oauth2") {
      expect(out.token_endpoint).toBe("https://example.com/token");
      expect(out.authorization_endpoint).toBe("https://example.com/authorize");
      expect(out.scopes).toBe("read write");
    }
  });

  it("returns null when neither form nor seed provide client_id", () => {
    const out = extractCredentialFromFormOutput(
      "oauth2",
      {},
      { values: { client_secret: "orphan" } },
    );
    expect(out).toBeNull();
  });

  it("rejects mustache placeholder client_secret in seedOverrides; form value wins", () => {
    // The LLM authors `{{client_secret}}` into the commit_intent payload
    // to mark "fill from form". The seed-side scrub in mergeFormIntoCredential
    // strips the secret key, but `seedString` here also rejects any
    // embedded placeholder so a leak through any path cannot poison
    // the real form value.
    const out = extractCredentialFromFormOutput(
      "oauth2",
      { client_id: "id", client_secret: "{{client_secret}}" },
      { values: { client_secret: "real-secret" } },
    );
    expect(out?.mode).toBe("oauth2");
    if (out?.mode === "oauth2") {
      expect(out.client_secret).toBe("real-secret");
    }
  });
});

describe("extractCredentialFromFormOutput — cognito_user_password direct seed", () => {
  it("accepts username + password from the form values map", () => {
    const out = extractCredentialFromFormOutput(
      "cognito_user_password",
      {},
      { values: { username: "u@x.com", password: "pw" } },
    );
    expect(out?.mode).toBe("cognito_user_password");
  });

  it("tolerates `email` as an alias for username (Cognito UX)", () => {
    const out = extractCredentialFromFormOutput(
      "cognito_user_password",
      {},
      { values: { email: "u@x.com", password: "pw" } },
    );
    expect(out?.mode).toBe("cognito_user_password");
    if (out?.mode === "cognito_user_password") {
      expect(out.username).toBe("u@x.com");
    }
  });

  it("threads aws_region, client_id, client_secret from seedOverrides into the bootstrap", () => {
    const out = extractCredentialFromFormOutput(
      "cognito_user_password",
      {
        aws_region: "us-east-1",
        client_id: "client_abc",
        client_secret: "secret_xyz",
      },
      { values: { username: "u@x.com", password: "pw" } },
    );
    expect(out?.mode).toBe("cognito_user_password");
    if (out?.mode === "cognito_user_password") {
      expect(out.aws_region).toBe("us-east-1");
      expect(out.client_id).toBe("client_abc");
      expect(out.client_secret).toBe("secret_xyz");
    }
  });

  it("returns null when the form is missing the password field", () => {
    expect(
      extractCredentialFromFormOutput(
        "cognito_user_password",
        {},
        { values: { username: "u@x.com" } },
      ),
    ).toBeNull();
  });
});

describe("extractCredentialFromFormOutput — aws_sigv4", () => {
  it("maps access_key_id + secret_access_key + optional session_token", () => {
    const out = extractCredentialFromFormOutput(
      "aws_sigv4",
      {},
      {
        values: {
          access_key_id: "AKIA...",
          secret_access_key: "secret...",
          session_token: "session...",
        },
      },
    );
    expect(out?.mode).toBe("aws_sigv4");
    if (out?.mode === "aws_sigv4") {
      expect(out.access_key_id).toBe("AKIA...");
      expect(out.secret_access_key).toBe("secret...");
      expect(out.session_token).toBe("session...");
    }
  });

  it("returns null when secret_access_key is missing", () => {
    expect(
      extractCredentialFromFormOutput("aws_sigv4", {}, { values: { access_key_id: "AKIA..." } }),
    ).toBeNull();
  });
});

describe("extractCredentialFromFormOutput — mustache placeholder rejection", () => {
  // The LLM occasionally hands us mustache-shaped seed values
  // (`{{password}}`, `{{secret_access_key}}`) that mean "form will
  // fill this slot". Pre-fix the seedString helper only stripped
  // whole-value matches; an embedded placeholder like
  // `"Bearer {{token}}"` would persist verbatim and every request
  // 401. Pass D3 widened the reject to any embedded `{{…}}`.

  it("cognito: form password wins over a whole-value mustache seed", () => {
    const out = extractCredentialFromFormOutput(
      "cognito_user_password",
      { username: "u@x.com", password: "{{password}}", aws_region: "eu-central-1" },
      { values: { password: "real-pw" } },
    );
    expect(out?.mode).toBe("cognito_user_password");
    if (out?.mode === "cognito_user_password") {
      expect(out.password).toBe("real-pw");
      expect(out.username).toBe("u@x.com");
    }
  });

  it("cognito: form password wins over an embedded mustache seed", () => {
    const out = extractCredentialFromFormOutput(
      "cognito_user_password",
      { username: "u@x.com", password: "Bearer {{password}}", aws_region: "eu-central-1" },
      { values: { password: "real-pw" } },
    );
    expect(out?.mode).toBe("cognito_user_password");
    if (out?.mode === "cognito_user_password") {
      expect(out.password).toBe("real-pw");
    }
  });

  it("aws_sigv4: form secret_access_key wins over a mustache seed", () => {
    const out = extractCredentialFromFormOutput(
      "aws_sigv4",
      { access_key_id: "{{access_key_id}}", secret_access_key: "{{secret_access_key}}" },
      { values: { access_key_id: "AKIAREAL", secret_access_key: "secretREAL" } },
    );
    expect(out?.mode).toBe("aws_sigv4");
    if (out?.mode === "aws_sigv4") {
      expect(out.access_key_id).toBe("AKIAREAL");
      expect(out.secret_access_key).toBe("secretREAL");
    }
  });
});

describe("extractCredentialFromFormOutput — basic api_token / apitoken / token aliases", () => {
  // Jira/Confluence and many other "Basic auth with an API token" providers label
  // the secret `api_token`. Pre-fix an `api_token=…` form submission matched nothing
  // and the credential was silently dropped → probe 401.

  it("accepts api_token as the password field (Jira/Confluence pattern)", () => {
    const out = extractCredentialFromFormOutput(
      "basic",
      {},
      { values: { username: "e@x.com", api_token: "T" } },
    );
    expect(out).toEqual({ mode: "basic", username: "e@x.com", password: "T" });
  });

  it("accepts apitoken (no underscore) as the password field", () => {
    const out = extractCredentialFromFormOutput(
      "basic",
      {},
      { values: { username: "e@x.com", apitoken: "T2" } },
    );
    expect(out).toEqual({ mode: "basic", username: "e@x.com", password: "T2" });
  });

  it("accepts `token` as the password field for basic mode", () => {
    const out = extractCredentialFromFormOutput(
      "basic",
      {},
      { values: { username: "user1", token: "tok-abc" } },
    );
    expect(out).toEqual({ mode: "basic", username: "user1", password: "tok-abc" });
  });

  it("accepts `email` as a username alias (Atlassian/JIRA cloud pattern)", () => {
    const out = extractCredentialFromFormOutput(
      "basic",
      {},
      { values: { email: "me@example.com", api_token: "mytoken" } },
    );
    expect(out).toEqual({ mode: "basic", username: "me@example.com", password: "mytoken" });
  });
});

describe("extractCredentialFromFormOutput — defensive", () => {
  it("returns null on an unknown seedMode", () => {
    expect(
      extractCredentialFromFormOutput("kerberos", {}, { values: { ticket: "..." } }),
    ).toBeNull();
  });

  it("treats an empty output as unsubmitted — never inferred", () => {
    expect(extractCredentialFromFormOutput("bearer", {}, {})).toBeNull();
  });

  it("is case-insensitive on form field names", () => {
    const out = extractCredentialFromFormOutput(
      "basic",
      {},
      { values: { Username: "alice", Password: "pw" } },
    );
    expect(out).toEqual({ mode: "basic", username: "alice", password: "pw" });
  });
});

describe("extractCredentialFromFormOutput — schema coverage cross-check", () => {
  // Guard against the next "we forgot to wire a new auth mode" latent
  // prod trip (which is exactly what bit gmail/google-*/msgraph for
  // four engine versions). Every variant of AtomicCredentialInput must
  // round-trip through extractCredentialFromFormOutput when given a
  // minimal happy-path form output. If you add a new credential mode
  // to AtomicCredentialInput, add it here AND wire the switch arm in
  // credential-cache.ts in the same commit.
  const minimalInputs = [
    { seedMode: "bearer", output: { values: { token: "t" } } },
    { seedMode: "basic", output: { values: { username: "u", password: "p" } } },
    {
      seedMode: "header",
      output: { values: { header_name: "X-K", header_value: "v" } },
    },
    { seedMode: "query", output: { values: { param: "k", value: "v" } } },
    {
      seedMode: "cognito_user_password",
      output: { values: { username: "u@x.com", password: "p" } },
    },
    {
      seedMode: "aws_sigv4",
      output: { values: { access_key_id: "AKIA...", secret_access_key: "s..." } },
    },
    {
      seedMode: "oauth2",
      output: { values: { client_id: "abc", client_secret: "xyz" } },
    },
  ] as const;

  for (const tc of minimalInputs) {
    it(`covers ${tc.seedMode}`, () => {
      const out = extractCredentialFromFormOutput(tc.seedMode, {}, tc.output);
      expect(out).not.toBeNull();
      expect(out?.mode).toBe(tc.seedMode);
    });
  }
});
