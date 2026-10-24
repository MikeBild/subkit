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
    const stringified = JSON.stringify({
      mode: "oauth2",
      client_id: "123456789012-xxx.apps.googleusercontent.com",
      client_secret: "GOCSPX-yyy",
    });
    const parsed = schema.safeParse({ credential: stringified });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const data = parsed.data as { credential?: Record<string, unknown> };
      expect(data.credential).toEqual({
        mode: "oauth2",
        client_id: "123456789012-xxx.apps.googleusercontent.com",
        client_secret: "GOCSPX-yyy",
      });
    }
  });

  it("falls through to the union error when a non-JSON string is supplied", () => {
    const parsed = schema.safeParse({ credential: "not-json" });
    expect(parsed.success).toBe(false);
  });
});
