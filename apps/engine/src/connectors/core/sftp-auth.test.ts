import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { type ParsedKey, utils } from "ssh2";
import {
  classifyKeyParseFailure,
  normalizePrivateKeyText,
  pkcs8ToSsh2Key,
  privateKeyFormat,
  privateKeyFormatIssue,
  SftpAuthConfigSchema,
  type SftpKeyErrorCode,
  sftpAuthConsistencyIssue,
  sftpAuthOf,
  sftpAuthTypeIssue,
  sftpKeyMessage,
  ssh2KeyInput,
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

  test("accepts OpenSSH, RSA, EC and PKCS#8 and refuses the rest", () => {
    expect(privateKeyFormatIssue(block("OPENSSH PRIVATE KEY"))).toBeNull();
    expect(privateKeyFormatIssue(block("RSA PRIVATE KEY"))).toBeNull();
    expect(privateKeyFormatIssue(block("EC PRIVATE KEY"))).toBeNull();
    expect(privateKeyFormatIssue(block("PRIVATE KEY"))).toBeNull();
    expect(privateKeyFormatIssue(block("ENCRYPTED PRIVATE KEY"))).toBeNull();
    expect(privateKeyFormatIssue(block("DSA PRIVATE KEY"))).toBe("sftp_key_format_unsupported");
    expect(privateKeyFormatIssue("hunter2")).toBe("sftp_key_not_private_key");
  });
});

const PASSPHRASE = "synthetic-pkcs8-passphrase";
const pkcs8 = (type: "rsa" | "ec" | "ed25519" | "x25519", options: Record<string, unknown> = {}) =>
  // biome-ignore lint/suspicious/noExplicitAny: generateKeyPairSync overloads per key type
  (generateKeyPairSync as any)(type, {
    ...options,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }) as { privateKey: string; publicKey: string };

function parsedPrivate(key: string): ParsedKey {
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error) throw parsed;
  return (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedKey;
}

describe("pkcs8ToSsh2Key", () => {
  test.each([
    ["rsa", { modulusLength: 2048 }, "RSA PRIVATE KEY", "ssh-rsa"],
    ["ec", { namedCurve: "P-256" }, "EC PRIVATE KEY", "ecdsa-sha2-nistp256"],
    ["ec", { namedCurve: "P-384" }, "EC PRIVATE KEY", "ecdsa-sha2-nistp384"],
    ["ec", { namedCurve: "P-521" }, "EC PRIVATE KEY", "ecdsa-sha2-nistp521"],
    ["ed25519", {}, "OPENSSH PRIVATE KEY", "ssh-ed25519"],
  ] as const)("turns a %s key into a key ssh2 reads", (type, options, label, sshType) => {
    const pair = pkcs8(type, options);
    const converted = pkcs8ToSsh2Key(pair.privateKey, null);
    if (!converted.ok) throw new Error(converted.reason);
    expect(converted.key.startsWith(`-----BEGIN ${label}-----\n`)).toBe(true);
    const key = parsedPrivate(converted.key);
    expect(key.isPrivateKey()).toBe(true);
    expect(key.type).toBe(sshType);
    const signature = key.sign(Buffer.from("challenge"));
    expect(key.verify(Buffer.from("challenge"), signature)).toBe(true);
    expect(pkcs8ToSsh2Key(pair.privateKey, null)).toEqual(converted);
  });

  test("writes the Ed25519 key in lines of 70 characters with the public key of the input", () => {
    const pair = pkcs8("ed25519");
    const converted = pkcs8ToSsh2Key(pair.privateKey, null);
    if (!converted.ok) throw new Error(converted.reason);
    const lines = converted.key.trim().split("\n");
    expect(lines.slice(1, -2).every((line) => line.length === 70)).toBe(true);
    const x = createPublicKey(pair.publicKey).export({ format: "jwk" }).x as string;
    const publicSsh = parsedPrivate(converted.key).getPublicSSH();
    expect(publicSsh.subarray(-32).toString("base64url")).toBe(x);
  });

  test("opens an encrypted key with the passphrase and tells a missing from a wrong one", () => {
    const { privateKey } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: PASSPHRASE,
      },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(privateKeyFormat(privateKey)).toBe("pkcs8_encrypted");
    const opened = pkcs8ToSsh2Key(privateKey, PASSPHRASE);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.key).not.toContain("ENCRYPTED");
    expect(parsedPrivate(opened.key).isPrivateKey()).toBe(true);
    expect(pkcs8ToSsh2Key(privateKey, null)).toEqual({
      ok: false,
      reason: "sftp_key_passphrase_required",
    });
    expect(pkcs8ToSsh2Key(privateKey, "not-the-passphrase")).toEqual({
      ok: false,
      reason: "sftp_key_passphrase_wrong",
    });
  });

  test("refuses key types SSH does not sign in with and a block that holds no key", () => {
    expect(pkcs8ToSsh2Key(pkcs8("x25519").privateKey, null)).toEqual({
      ok: false,
      reason: "sftp_key_format_unsupported",
    });
    expect(pkcs8ToSsh2Key(pkcs8("ec", { namedCurve: "P-224" }).privateKey, null)).toEqual({
      ok: false,
      reason: "sftp_key_format_unsupported",
    });
    expect(pkcs8ToSsh2Key(block("PRIVATE KEY"), null)).toEqual({
      ok: false,
      reason: "sftp_key_not_private_key",
    });
  });
});

describe("ssh2KeyInput", () => {
  test("passes OpenSSH and PEM keys through with their passphrase", () => {
    expect(ssh2KeyInput(block("OPENSSH PRIVATE KEY"), "pass")).toEqual({
      ok: true,
      key: block("OPENSSH PRIVATE KEY"),
      passphrase: "pass",
    });
  });

  test("hands a converted PKCS#8 key on without the passphrase", () => {
    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: PASSPHRASE,
      },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const input = ssh2KeyInput(privateKey, PASSPHRASE);
    expect(input.ok && input.passphrase).toBeNull();
    expect(input.ok && input.key.startsWith("-----BEGIN EC PRIVATE KEY-----")).toBe(true);
  });

  test("names the reason a key cannot be used", () => {
    expect(ssh2KeyInput("hunter2", null)).toEqual({
      ok: false,
      reason: "sftp_key_not_private_key",
    });
    expect(ssh2KeyInput(block("DSA PRIVATE KEY"), null)).toEqual({
      ok: false,
      reason: "sftp_key_format_unsupported",
    });
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
