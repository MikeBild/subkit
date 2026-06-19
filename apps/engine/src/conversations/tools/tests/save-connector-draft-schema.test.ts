// Schema-only tests for `save_connector_draft`'s discriminated-union
// `credential` input. Pre-fix the union only accepted bearer / basic /
// header / query — so the LLM's diagnostic re-issue with `mode:
// "cognito_user_password"` (or `oauth2`) raised a Zod parse error and
// the operator was bounced into the dead-end "credential mode 'oauth2'
// is not recognized in the current schema" path. Reproduces the
// failure mode from session bab50df1.

import { describe, expect, it } from "bun:test";
import { saveConnectorDraftTool } from "../save-connector-draft.ts";

const schema = saveConnectorDraftTool.inputSchema;

describe("save_connector_draft — credential discriminated-union", () => {
  it("accepts mode:cognito_user_password with username + password", () => {
    const parsed = schema.safeParse({
      credential: {
        mode: "cognito_user_password",
        username: "u@x.com",
        password: "pw",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts mode:cognito_user_password with full Cognito fields", () => {
    const parsed = schema.safeParse({
      credential: {
        mode: "cognito_user_password",
        username: "u@x.com",
        password: "pw",
        aws_region: "eu-central-1",
        client_id: "abc",
        client_secret: "shh",
        use_access_token: true,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts mode:aws_sigv4 (with optional session_token)", () => {
    const parsed = schema.safeParse({
      credential: {
        mode: "aws_sigv4",
        access_key_id: "AKIA",
        secret_access_key: "secret",
        session_token: "session",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects mode:oauth2 (the post-exchange shape — never an input mode)", () => {
    // oauth2 is what the engine PERSISTS after the bootstrap; it is
    // never a valid input shape for this tool. The LLM should declare
    // the bootstrap mode (cognito_user_password) instead.
    const parsed = schema.safeParse({
      credential: { mode: "oauth2", access_token: "..." },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown mode entirely", () => {
    const parsed = schema.safeParse({
      credential: { mode: "kerberos", ticket: "..." },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects cognito_user_password with empty username", () => {
    const parsed = schema.safeParse({
      credential: { mode: "cognito_user_password", username: "", password: "pw" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects aws_sigv4 missing secret_access_key", () => {
    const parsed = schema.safeParse({
      credential: { mode: "aws_sigv4", access_key_id: "AKIA" },
    });
    expect(parsed.success).toBe(false);
  });

  it("permits omitting the credential entirely (idempotent re-issue)", () => {
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it("accepts a JSON-stringified credential payload (AI SDK 6 strict-mode quirk)", () => {
    // Reproduces the Gmail-OAuth2 dead-end from session 37a6d350
    // (2026-05-12, trace cli-eff8d7d79d724c56): under Anthropic SDK 6
    // strict structured output the model sometimes emits a nested
    // object as a JSON string. The preprocessor must parse it before
    // the discriminated union runs.
    const stringified = JSON.stringify({
      mode: "oauth2",
      client_id: "86471638913-xxx.apps.googleusercontent.com",
      client_secret: "GOCSPX-yyy",
    });
    const parsed = schema.safeParse({ credential: stringified });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const data = parsed.data as { credential?: Record<string, unknown> };
      expect(data.credential).toEqual({
        mode: "oauth2",
        client_id: "86471638913-xxx.apps.googleusercontent.com",
        client_secret: "GOCSPX-yyy",
      });
    }
  });

  it("falls through to the union error when a non-JSON string is supplied", () => {
    // A real misuse — the operator typed a bare secret. The schema
    // should still fail (the union's typed error is more useful than
    // silently coercing). The preprocessor only handles strings that
    // look like JSON objects.
    const parsed = schema.safeParse({ credential: "not-json" });
    expect(parsed.success).toBe(false);
  });
});
