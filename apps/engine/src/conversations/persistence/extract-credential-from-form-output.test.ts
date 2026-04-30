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

  it("returns null for plain oauth2 without any cognito hint (caller surfaces credential_required)", () => {
    // Authorization-code, client-credentials, jwt-bearer, and
    // device-code grants don't go through the form-submit path —
    // they have dedicated flows. Plain oauth2 with no Cognito hint
    // should NOT silently land as some other mode.
    const out = extractCredentialFromFormOutput(
      "oauth2",
      {},
      { values: { username: "u@x.com", password: "pw" } },
    );
    expect(out).toBeNull();
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
