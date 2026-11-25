import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_SHAPE_HELP,
  credentialHint,
  parseCredentialFile,
} from "./connector-credential-file-model.ts";

describe("parseCredentialFile", () => {
  test.each([
    [{ token: "t" }, "`mode` is required"],
    [{ kind: "bearer", token: "t" }, "`mode` is required"],
    [{ mode: "oauth", token: "t" }, "`mode` must be one of"],
    [{ mode: "bearer" }, "mode bearer requires `token`"],
    [{ mode: "basic", username: "u" }, "mode basic requires `password`"],
    [{ mode: "header", headers: "x" }, "mode header requires `headers`"],
    [{ mode: "aws_sigv4", access_key_id: "a" }, "mode aws_sigv4 requires `secret_access_key`"],
    [{ mode: "signed_jwt" }, "mode signed_jwt requires `private_key`"],
    [{ mode: "connection" }, "mode connection requires `connection_id`"],
    [[], "must be a JSON object"],
    ["bearer", "must be a JSON object"],
  ])("rejects %j naming the offending field", (raw, message) => {
    expect(() => parseCredentialFile(raw)).toThrow(message);
  });

  test("the missing-mode error lists the modes and an example", () => {
    expect(() => parseCredentialFile({ token: "t" })).toThrow(
      'credential file: field `mode` is required (one of none|header|query|bearer|basic|aws_sigv4|signed_jwt|connection), e.g. {"mode":"bearer","token":"…"}',
    );
  });

  test.each([
    [{ mode: "bearer", token: "t" }],
    [{ mode: "none" }],
    [{ mode: "basic", username: "u", password: "" }],
    [{ mode: "header", headers: { "x-api-key": "k" } }],
    [{ mode: "query", query: { key: "k" } }],
    [{ mode: "aws_sigv4", access_key_id: "a", secret_access_key: "s", session_token: "x" }],
  ])("accepts %j unchanged", (raw) => {
    expect(parseCredentialFile(raw)).toEqual(raw as never);
  });

  test("the shape help covers every mode", () => {
    for (const mode of ["bearer", "basic", "header", "query", "aws_sigv4", "signed_jwt"]) {
      expect(CREDENTIAL_SHAPE_HELP).toContain(mode);
    }
    expect(CREDENTIAL_SHAPE_HELP).toContain("username+password");
  });
});

describe("credentialHint", () => {
  test("replaces the chat-tool detail of a credential_missing probe with a CLI hint", () => {
    const hint = credentialHint({
      error_code: "credential_missing",
      detail:
        "credential_required: probe requires a saved credential — collect one via ask_user_form and persist via save_connector_draft({credential})",
    });
    expect(hint).toContain("--credential <file>");
    expect(hint).toContain("subkit vault attach");
    expect(hint).not.toContain("ask_user_form");
    expect(hint).not.toContain("save_connector_draft");
  });

  test("keeps the detail for any other failure", () => {
    expect(credentialHint({ detail: "token rejected" })).toBe("token rejected");
    expect(credentialHint({})).toBeUndefined();
  });
});
