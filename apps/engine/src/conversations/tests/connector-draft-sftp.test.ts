import { describe, expect, test } from "bun:test";
import { validateConnectorDraft } from "../connector-draft.ts";

const pin = `SHA256:${"A".repeat(43)}`;
const key = { method: "private_key", username: "deploy", private_key_item: "sftp-deploy-key" };

function draft(auth_type: "basic" | "none" | "bearer", config: Record<string, unknown>) {
  return validateConnectorDraft(
    {
      name: "Files",
      slug: "files",
      driver: "sftp",
      environment: "prod",
      auth_type,
      base_url: "sftp://files.example.test/inbox",
      config: { host_key_sha256: pin, ...config },
    },
    [],
  );
}

describe("sftp connector draft validation", () => {
  test("accepts a password draft and an SSH key draft", () => {
    expect(draft("basic", {}).errors).toEqual([]);
    expect(draft("none", { auth: key }).errors).toEqual([]);
  });

  test("refuses other auth kinds and a mismatched pairing", () => {
    expect(draft("bearer", {}).errors).toContainEqual(
      expect.objectContaining({ path: "auth_type" }),
    );
    expect(draft("none", {}).errors).toContainEqual(
      expect.objectContaining({ path: "config.auth" }),
    );
    expect(draft("basic", { auth: key }).errors).toContainEqual(
      expect.objectContaining({ path: "auth_type" }),
    );
  });
});
