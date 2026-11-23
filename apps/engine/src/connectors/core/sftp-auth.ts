import { isVaultItemName } from "@shared/vault-handle.ts";
import { z } from "zod";

const VaultItemNameSchema = z
  .string()
  .refine(
    isVaultItemName,
    "must be the name of a workspace vault item, for example sftp-deploy-key",
  );

export const SftpAuthConfigSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("password") }).strict(),
  z
    .object({
      method: z.literal("private_key"),
      username: z.string().trim().min(1).max(256),
      private_key_item: VaultItemNameSchema,
      passphrase_item: VaultItemNameSchema.optional(),
    })
    .strict(),
]);

export type SftpAuth =
  | { readonly method: "password" }
  | {
      readonly method: "private_key";
      readonly username: string;
      readonly private_key_item: string;
      readonly passphrase_item: string | null;
    };

export type SftpKeyErrorCode =
  | "sftp_auth_invalid"
  | "sftp_key_item_missing"
  | "sftp_key_item_unreadable"
  | "sftp_key_not_private_key"
  | "sftp_key_format_unsupported"
  | "sftp_key_passphrase_required"
  | "sftp_key_passphrase_wrong"
  | "sftp_key_rejected";

export type PrivateKeyFormat = "openssh" | "rsa" | "ec" | "pkcs8" | "pkcs8_encrypted" | "other";

export interface SftpAuthIssue {
  readonly path: string;
  readonly message: string;
}

export function sftpAuthOf(config: unknown): SftpAuth | null {
  const raw = (config ?? {}) as Record<string, unknown>;
  if (raw.auth === undefined) return { method: "password" };
  const parsed = SftpAuthConfigSchema.safeParse(raw.auth);
  if (!parsed.success) return null;
  if (parsed.data.method === "password") return { method: "password" };
  return {
    method: "private_key",
    username: parsed.data.username,
    private_key_item: parsed.data.private_key_item,
    passphrase_item: parsed.data.passphrase_item ?? null,
  };
}

export function sftpAuthTypeIssue(auth_type: string): SftpAuthIssue | null {
  if (auth_type === "basic" || auth_type === "none") return null;
  return {
    path: "auth_type",
    message:
      "an sftp connector signs in with a username and password (auth_type 'basic') or with an SSH key from the vault (auth_type 'none' and config.auth.method 'private_key')",
  };
}

export function sftpAuthConsistencyIssue(auth_type: string, config: unknown): SftpAuthIssue | null {
  const auth = sftpAuthOf(config);
  if (!auth) return null;
  if (auth_type === "basic" && auth.method === "private_key")
    return {
      path: "auth_type",
      message:
        "an sftp connector that signs in with an SSH key from the vault stores no credential — use auth_type 'none'",
    };
  if (auth_type === "none" && auth.method === "password")
    return {
      path: "config.auth",
      message:
        "an sftp connector without a stored password signs in with an SSH key — set config.auth to { method: 'private_key', username, private_key_item }",
    };
  return null;
}

const PEM_BLOCK = /^-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----$/;
const BASE64_BODY = /^[A-Za-z0-9+/=]+$/;
const LINE_WIDTH = 64;

export function normalizePrivateKeyText(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  const block = PEM_BLOCK.exec(text);
  if (!block) return text;
  const label = block[1] as string;
  const body = (block[2] as string).replace(/\s+/g, "");
  if (!BASE64_BODY.test(body)) return `${text}\n`;
  const lines = body.match(new RegExp(`.{1,${LINE_WIDTH}}`, "g")) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`, ""].join("\n");
}

export function privateKeyFormat(text: string): PrivateKeyFormat | null {
  const label = /^-----BEGIN ([A-Z0-9 ]+)-----/.exec(text.trim())?.[1];
  if (label === undefined || !label.endsWith("PRIVATE KEY")) return null;
  if (label === "OPENSSH PRIVATE KEY") return "openssh";
  if (label === "RSA PRIVATE KEY") return "rsa";
  if (label === "EC PRIVATE KEY") return "ec";
  if (label === "PRIVATE KEY") return "pkcs8";
  if (label === "ENCRYPTED PRIVATE KEY") return "pkcs8_encrypted";
  return "other";
}

export function privateKeyFormatIssue(text: string): SftpKeyErrorCode | null {
  const format = privateKeyFormat(text);
  if (format === null) return "sftp_key_not_private_key";
  if (format === "openssh" || format === "rsa" || format === "ec") return null;
  return "sftp_key_format_unsupported";
}

export function classifyKeyParseFailure(
  message: string,
  passphraseGiven: boolean,
): SftpKeyErrorCode {
  if (/passphrase/i.test(message))
    return passphraseGiven ? "sftp_key_passphrase_wrong" : "sftp_key_passphrase_required";
  return "sftp_key_not_private_key";
}

export function sftpKeyMessage(
  code: SftpKeyErrorCode,
  facts: { readonly item: string; readonly environment: string; readonly host?: string },
): string {
  switch (code) {
    case "sftp_auth_invalid":
      return "config.auth of this sftp connector is invalid; nothing was sent";
    case "sftp_key_item_missing":
      return `no workspace vault secret named ${facts.item} in ${facts.environment}; store the key in the vault as a secret first`;
    case "sftp_key_item_unreadable":
      return `vault item ${facts.item} can't be opened with the current key`;
    case "sftp_key_not_private_key":
      return `vault item ${facts.item} does not hold an SSH private key`;
    case "sftp_key_format_unsupported":
      return `vault item ${facts.item} holds a PKCS#8 or unknown key format; store it in OpenSSH, RSA or EC PEM format (ssh-keygen -p -f key)`;
    case "sftp_key_passphrase_required":
      return `the key in vault item ${facts.item} is encrypted; set config.auth.passphrase_item to the vault secret that holds its passphrase`;
    case "sftp_key_passphrase_wrong":
      return `the passphrase does not open the key in vault item ${facts.item}`;
    case "sftp_key_rejected":
      return `${facts.host ?? "the server"} refused the SSH key from vault item ${facts.item}`;
  }
}
