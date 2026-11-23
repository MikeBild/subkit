import { describe, expect, test } from "bun:test";
import {
  classifyKeyParseFailure,
  normalizePrivateKeyText,
  privateKeyFormat,
  privateKeyFormatIssue,
  SftpAuthConfigSchema,
  type SftpKeyErrorCode,
  sftpAuthConsistencyIssue,
  sftpAuthOf,
  sftpAuthTypeIssue,
  sftpKeyMessage,
} from "./sftp-auth.ts";

const BODY = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJz";
const block = (label: string, body = BODY) =>
  `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
const keyAuth = { method: "private_key", username: "deploy", private_key_item: "sftp-key" };

describe("SftpAuthConfigSchema", () => {
  test("accepts password and private_key with item names", () => {
    expect(SftpAuthConfigSchema.safeParse({ method: "password" }).success).toBe(true);
    expect(SftpAuthConfigSchema.safeParse(keyAuth).success).toBe(true);
    expect(
      SftpAuthConfigSchema.safeParse({ ...keyAuth, passphrase_item: "sftp-key-pass" }).success,
    ).toBe(true);
  });

  test("refuses key material, placeholders and unknown fields in place of item names", () => {
    for (const private_key_item of [block("OPENSSH PRIVATE KEY"), "${secret.sftp-key}", "me", ""])
      expect(SftpAuthConfigSchema.safeParse({ ...keyAuth, private_key_item }).success).toBe(false);
    expect(SftpAuthConfigSchema.safeParse({ ...keyAuth, private_key: "x" }).success).toBe(false);
    expect(SftpAuthConfigSchema.safeParse({ ...keyAuth, username: " " }).success).toBe(false);
    expect(SftpAuthConfigSchema.safeParse({ method: "password", password: "x" }).success).toBe(
      false,
    );
  });
});

describe("sftpAuthOf", () => {
  test("defaults to password without an auth block", () => {
    expect(sftpAuthOf(undefined)).toEqual({ method: "password" });
    expect(sftpAuthOf({ host_key_sha256: "SHA256:x" })).toEqual({ method: "password" });
    expect(sftpAuthOf({ auth: { method: "password" } })).toEqual({ method: "password" });
  });

  test("reads the private key block with an optional passphrase item", () => {
    expect(sftpAuthOf({ auth: keyAuth })).toEqual({
      method: "private_key",
      username: "deploy",
      private_key_item: "sftp-key",
      passphrase_item: null,
    });
    expect(sftpAuthOf({ auth: { ...keyAuth, passphrase_item: "sftp-pass" } })).toMatchObject({
      passphrase_item: "sftp-pass",
    });
  });

  test("returns null for an invalid auth block", () => {
    expect(sftpAuthOf({ auth: { method: "certificate" } })).toBeNull();
  });
});

describe("sftpAuthTypeIssue and sftpAuthConsistencyIssue", () => {
  test("allows basic and none only", () => {
    expect(sftpAuthTypeIssue("basic")).toBeNull();
    expect(sftpAuthTypeIssue("none")).toBeNull();
    expect(sftpAuthTypeIssue("bearer")?.path).toBe("auth_type");
  });

  test("pairs basic with password and none with private_key", () => {
    expect(sftpAuthConsistencyIssue("basic", {})).toBeNull();
    expect(sftpAuthConsistencyIssue("none", { auth: keyAuth })).toBeNull();
    expect(sftpAuthConsistencyIssue("basic", { auth: keyAuth })?.path).toBe("auth_type");
    expect(sftpAuthConsistencyIssue("none", {})?.path).toBe("config.auth");
    expect(sftpAuthConsistencyIssue("none", { auth: { method: "x" } })).toBeNull();
  });
});

describe("normalizePrivateKeyText", () => {
  test("turns CRLF into LF and ends with a newline", () => {
    expect(normalizePrivateKeyText(block("RSA PRIVATE KEY").replace(/\n/g, "\r\n"))).toBe(
      block("RSA PRIVATE KEY"),
    );
  });

  test("restores line breaks of a key pasted into one line", () => {
    const long = BODY.repeat(3);
    const flat = `-----BEGIN OPENSSH PRIVATE KEY----- ${long} -----END OPENSSH PRIVATE KEY-----`;
    const out = normalizePrivateKeyText(flat);
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(lines.at(-1)).toBe("-----END OPENSSH PRIVATE KEY-----");
    expect(lines.slice(1, -1).join("")).toBe(long);
    expect(lines.slice(1, -1).every((line) => line.length <= 64)).toBe(true);
  });

  test("keeps a block with PEM headers and text without a block as given", () => {
    const encrypted =
      "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n\nQUJD\n-----END RSA PRIVATE KEY-----";
    expect(normalizePrivateKeyText(encrypted)).toBe(`${encrypted}\n`);
    expect(normalizePrivateKeyText("  not a key  ")).toBe("not a key");
  });
});

describe("privateKeyFormat and privateKeyFormatIssue", () => {
  test("names the key family from the header only", () => {
    expect(privateKeyFormat(block("OPENSSH PRIVATE KEY"))).toBe("openssh");
    expect(privateKeyFormat(block("RSA PRIVATE KEY"))).toBe("rsa");
    expect(privateKeyFormat(block("EC PRIVATE KEY"))).toBe("ec");
    expect(privateKeyFormat(block("PRIVATE KEY"))).toBe("pkcs8");
    expect(privateKeyFormat(block("ENCRYPTED PRIVATE KEY"))).toBe("pkcs8_encrypted");
    expect(privateKeyFormat(block("DSA PRIVATE KEY"))).toBe("other");
    expect(privateKeyFormat(block("PUBLIC KEY"))).toBeNull();
    expect(privateKeyFormat("ssh-ed25519 AAAA deploy@example")).toBeNull();
  });

  test("accepts OpenSSH, RSA and EC and refuses the rest", () => {
    expect(privateKeyFormatIssue(block("OPENSSH PRIVATE KEY"))).toBeNull();
    expect(privateKeyFormatIssue(block("RSA PRIVATE KEY"))).toBeNull();
    expect(privateKeyFormatIssue(block("EC PRIVATE KEY"))).toBeNull();
    expect(privateKeyFormatIssue(block("PRIVATE KEY"))).toBe("sftp_key_format_unsupported");
    expect(privateKeyFormatIssue(block("DSA PRIVATE KEY"))).toBe("sftp_key_format_unsupported");
    expect(privateKeyFormatIssue("hunter2")).toBe("sftp_key_not_private_key");
  });
});

describe("classifyKeyParseFailure", () => {
  test("tells a missing from a wrong passphrase", () => {
    const missing = "Encrypted private OpenSSH key detected, but no passphrase given";
    expect(classifyKeyParseFailure(missing, false)).toBe("sftp_key_passphrase_required");
    expect(classifyKeyParseFailure("integrity check failed -- bad passphrase?", true)).toBe(
      "sftp_key_passphrase_wrong",
    );
    expect(classifyKeyParseFailure("Unsupported key format", true)).toBe(
      "sftp_key_not_private_key",
    );
  });
});

describe("sftpKeyMessage", () => {
  const codes: SftpKeyErrorCode[] = [
    "sftp_auth_invalid",
    "sftp_key_item_missing",
    "sftp_key_item_unreadable",
    "sftp_key_not_private_key",
    "sftp_key_format_unsupported",
    "sftp_key_passphrase_required",
    "sftp_key_passphrase_wrong",
    "sftp_key_rejected",
  ];

  test.each(codes)("%s names the item and nothing else", (code) => {
    const message = sftpKeyMessage(code, { item: "sftp-key", environment: "prod" });
    expect(message.length).toBeGreaterThan(10);
    expect(message).not.toContain("BEGIN");
    if (code !== "sftp_auth_invalid") expect(message).toContain("sftp-key");
  });

  test("names the host when the server refuses the key", () => {
    expect(
      sftpKeyMessage("sftp_key_rejected", {
        item: "sftp-key",
        environment: "dev",
        host: "files.example.com",
      }),
    ).toStartWith("files.example.com refused");
    expect(sftpKeyMessage("sftp_key_item_missing", { item: "k", environment: "dev" })).toContain(
      "in dev",
    );
  });
});
