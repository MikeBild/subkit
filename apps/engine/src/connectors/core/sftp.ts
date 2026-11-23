import { createHash } from "node:crypto";

export const SFTP_DEFAULT_PORT = 22;

export type SftpMethod = "LIST" | "GET" | "PUT" | "DELETE";

export interface SftpAddress {
  host: string;
  port: number;
  root: string;
}

export type SftpRefusalCode =
  | "sftp_address_invalid"
  | "sftp_host_key_missing"
  | "sftp_path_invalid"
  | "sftp_path_outside_root"
  | "sftp_delete_not_a_file"
  | "sftp_delete_body_refused";

export class SftpRefusal extends Error {
  constructor(
    readonly code: SftpRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "SftpRefusal";
  }
}

export function parseSftpAddress(baseUrl: string | null | undefined): SftpAddress {
  let url: URL;
  try {
    url = new URL(baseUrl ?? "");
  } catch {
    throw new SftpRefusal(
      "sftp_address_invalid",
      "the connector address must be sftp://host[:port]/folder",
    );
  }
  if (url.protocol !== "sftp:" || url.hostname === "")
    throw new SftpRefusal(
      "sftp_address_invalid",
      "the connector address must be sftp://host[:port]/folder",
    );
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    throw new SftpRefusal(
      "sftp_address_invalid",
      "the connector address carries only host, port and folder; credentials belong in the stored credential",
    );
  const root = normalizeSftpPath(decodeURIComponent(url.pathname || "/"));
  return {
    host: url.hostname,
    port: url.port === "" ? SFTP_DEFAULT_PORT : Number(url.port),
    root,
  };
}

function normalizeSftpPath(path: string): string {
  if (path.includes("\0"))
    throw new SftpRefusal("sftp_path_invalid", "the path contains a NUL byte");
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..")
      throw new SftpRefusal("sftp_path_outside_root", "the path must not contain `..` segments");
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

export function resolveSftpPath(root: string, path: string): string {
  const relative = normalizeSftpPath(path);
  const base = normalizeSftpPath(root);
  if (base === "/") return relative;
  if (relative === "/") return base;
  return `${base}${relative}`;
}

export function assertRemovableSftpFile(path: string, body: unknown): void {
  if (body !== undefined && body !== null)
    throw new SftpRefusal(
      "sftp_delete_body_refused",
      "sftp DELETE does not accept a body — remove one file per request (for_each with sftp.path)",
    );
  if (path === "" || path === "/" || path.endsWith("/"))
    throw new SftpRefusal(
      "sftp_delete_not_a_file",
      `sftp DELETE path "${path}" is a folder, not a file`,
    );
}

export function sftpHostKeyFingerprint(key: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function normalizeHostKeyPin(pin: string): string {
  const trimmed = pin.trim();
  const body = trimmed.startsWith("SHA256:") ? trimmed.slice("SHA256:".length) : trimmed;
  return `SHA256:${body.replace(/=+$/, "")}`;
}

export function sftpHostKeyMatches(pin: string | null | undefined, key: Uint8Array): boolean {
  if (!pin || pin.trim() === "") return false;
  return normalizeHostKeyPin(pin) === sftpHostKeyFingerprint(key);
}

export function sftpMethodWrites(method: SftpMethod): boolean {
  return method === "PUT" || method === "DELETE";
}
