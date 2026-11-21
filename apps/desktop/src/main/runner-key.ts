import { createPrivateKey, sign } from "node:crypto";

export function signAssertion(privateKeyPem: string, assertion: string): string {
  return sign(null, Buffer.from(assertion, "utf8"), createPrivateKey(privateKeyPem)).toString(
    "base64url",
  );
}
