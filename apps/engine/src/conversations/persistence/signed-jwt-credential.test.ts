import { describe, expect, test } from "bun:test";
import { credentialValueOf } from "../../api/operations/connector-credentials.ts";
import { isRejection } from "../../api/operations/index.ts";
import { redactSignedJwtValue } from "../../connectors/drivers/http.ts";
import { flattenCredential } from "../../llm/substitution/resolver.ts";
import { scrubSecrets, scrubString } from "../../logging/scrub-secrets.ts";
import { isDraftCredentialSetupAuthType } from "../draft-credential-setup.ts";
import { saveConnectorDraftTool } from "../tools/save-connector-draft.ts";
import { extractCredentialFromFormOutput } from "./auto-persist/credential-cache.ts";
import { validateCredentialFormFields } from "./credential-form-contract.ts";
import { toDecryptedCredential } from "./draft-credential-cache.ts";

const privateKey = "-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----";

describe("signed JWT credential boundaries", () => {
  test("reflected tokens are removed from JSON keys and values", () => {
    expect(redactSignedJwtValue({ "echo-token": ["echo-token"] }, "echo-token")).toEqual({
      "[REDACTED]": ["[REDACTED]"],
    });
  });
  test("secure form accepts the key rather than a generated bearer token", () => {
    expect(isDraftCredentialSetupAuthType("signed_jwt")).toBe(true);
    expect(
      validateCredentialFormFields({ seedMode: "signed_jwt", fieldNames: ["private_key"] }).ok,
    ).toBe(true);
    expect(validateCredentialFormFields({ seedMode: "signed_jwt", fieldNames: ["token"] }).ok).toBe(
      false,
    );
    expect(
      extractCredentialFromFormOutput("signed_jwt", {}, { values: { private_key: privateKey } }),
    ).toEqual({ mode: "signed_jwt", private_key: privateKey });
    expect(
      extractCredentialFromFormOutput("signed_jwt", {}, { values: { token: "expired-token" } }),
    ).toBeNull();
  });

  test("API, draft and secure cache preserve the credential shape", () => {
    const credential = { mode: "signed_jwt" as const, private_key: privateKey };
    expect(credentialValueOf(credential)).toEqual(credential);
    expect(toDecryptedCredential(credential)).toEqual(credential);
    expect(saveConnectorDraftTool.inputSchema.safeParse({ credential }).success).toBe(true);
    const missingKey = credentialValueOf({ mode: "signed_jwt" });
    expect(isRejection(missingKey)).toBe(true);
    expect(isRejection(missingKey) ? missingKey.message : "").toContain("private_key");
    expect(
      saveConnectorDraftTool.inputSchema.safeParse({
        credential: { mode: "signed_jwt", token: "jwt" },
      }).success,
    ).toBe(false);
  });

  test("private keys cannot be substituted into workflow content and are scrubbed from output", () => {
    expect(
      flattenCredential("signed_jwt", { mode: "signed_jwt", private_key: privateKey }),
    ).toEqual({});
    expect(JSON.stringify(scrubSecrets({ private_key: privateKey }))).not.toContain("fixture-only");
    expect(scrubString(`Provider echoed ${privateKey}`)).not.toContain("fixture-only");
  });
});
