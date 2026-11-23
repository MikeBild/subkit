import { basename } from "node:path";
import { Client, type FileEntryWithStats, type SFTPWrapper } from "ssh2";
import {
  type CredentialUseSnapshot,
  type DecryptedCredential,
  getCredentialForConnector,
} from "../../credentials/index.ts";
import type { Db } from "../../db/index.ts";
import { errorFields, logger } from "../../logging/index.ts";
import {
  assertRemovableSftpFile,
  parseSftpAddress,
  resolveSftpPath,
  type SftpMethod,
  SftpRefusal,
  sftpHostKeyMatches,
} from "../core/sftp.ts";
import { openSftpSocket } from "../sftp-egress.ts";
import type { ConnectorView } from "../types.ts";
import type { DriverProbeResult } from "./index.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const STATUS_NO_SUCH_FILE = 2;
const STATUS_PERMISSION_DENIED = 3;

export type SftpErrorCode =
  | "credential_missing"
  | "credential_mode_unsupported_for_sftp"
  | "sftp_host_key_missing"
  | "sftp_host_key_mismatch";

export class SftpConnectorError extends Error {
  constructor(
    message: string,
    readonly error_code: SftpErrorCode,
  ) {
    super(message);
    this.name = "SftpConnectorError";
  }
}

export interface SftpEntry {
  name: string;
  path: string;
  type: "file" | "folder" | "other";
  size_bytes: number;
  modified_at: string | null;
}

export interface SftpResponse {
  status: number;
  path: string;
  entries?: SftpEntry[];
  file?: { filename: string; bytes: Buffer };
  bytes_out?: number;
}

export interface SftpRequestParams {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  method: SftpMethod;
  path: string;
  body?: Buffer | null;
  max_entries?: number;
  timeout_ms?: number;
  on_credential_use?: (snapshot: CredentialUseSnapshot) => Promise<void>;
  credential_override?: DecryptedCredential | null;
}

interface SftpLogin {
  username: string;
  password: string;
  snapshot: CredentialUseSnapshot;
}

async function resolveSftpLogin(p: SftpRequestParams): Promise<SftpLogin> {
  const row =
    p.credential_override !== undefined
      ? p.credential_override && {
          value: p.credential_override,
          row: { id: null as string | null, credential_generation: null, verified_identity: null },
        }
      : await getCredentialForConnector(p.tenant_id, p.connector.id, p.connector.environment, p.db);
  if (!row)
    throw new SftpConnectorError(
      `sftp connector ${p.connector.slug} has no stored credential for environment ${p.connector.environment}`,
      "credential_missing",
    );
  if (row.value.mode !== "basic")
    throw new SftpConnectorError(
      `sftp driver signs in with a username and password; a "${row.value.mode}" credential cannot be used`,
      "credential_mode_unsupported_for_sftp",
    );
  return {
    username: row.value.username,
    password: row.value.password,
    snapshot: {
      connector_id: p.connector.id,
      environment: p.connector.environment,
      credential_id: row.row.id,
      credential_generation: row.row.credential_generation,
      connection_id: null,
      access_token_version: null,
      identity: row.row.verified_identity,
    },
  };
}

function hostKeyPin(connector: ConnectorView): string {
  const cfg = (connector.config ?? {}) as Record<string, unknown>;
  const pin = typeof cfg.host_key_sha256 === "string" ? cfg.host_key_sha256.trim() : "";
  if (!pin)
    throw new SftpConnectorError(
      `sftp connector ${connector.slug} has no pinned host key; nothing was sent`,
      "sftp_host_key_missing",
    );
  return pin;
}

async function withSftpSession<T>(
  p: SftpRequestParams,
  login: SftpLogin,
  run: (sftp: SftpSession) => Promise<T>,
): Promise<T> {
  const address = parseSftpAddress(p.connector.base_url);
  const pin = hostKeyPin(p.connector);
  const timeout = p.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const sock = await openSftpSocket(address, { tenant_id: p.tenant_id, exec: p.db }, timeout);
  const client = new Client();
  let keyRefused = false;
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("ready", () => resolve());
      client.once("error", (err) =>
        reject(
          keyRefused
            ? new SftpConnectorError(
                `the host key of ${address.host} does not match the pinned key; nothing was sent`,
                "sftp_host_key_mismatch",
              )
            : err,
        ),
      );
      client.connect({
        sock,
        username: login.username,
        password: login.password,
        readyTimeout: timeout,
        hostVerifier: (key: Buffer) => {
          const ok = sftpHostKeyMatches(pin, key);
          if (!ok) keyRefused = true;
          return ok;
        },
      });
    });
    const wrapper = await new Promise<SFTPWrapper>((resolve, reject) =>
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))),
    );
    return await run(new SftpSession(wrapper, address.root));
  } finally {
    client.end();
    sock.destroy();
  }
}

class SftpStatusError extends Error {
  constructor(readonly status: number) {
    super(`sftp status ${status}`);
  }
}

function settle<T>(resolve: (v: T) => void, reject: (e: unknown) => void) {
  return (err: (Error & { code?: number }) | null | undefined, value?: T) => {
    if (!err) return resolve(value as T);
    if (err.code === STATUS_NO_SUCH_FILE) return reject(new SftpStatusError(404));
    if (err.code === STATUS_PERMISSION_DENIED) return reject(new SftpStatusError(403));
    reject(err);
  };
}

class SftpSession {
  constructor(
    private readonly sftp: SFTPWrapper,
    readonly root: string,
  ) {}

  list(path: string): Promise<FileEntryWithStats[]> {
    return new Promise((resolve, reject) => this.sftp.readdir(path, settle(resolve, reject)));
  }

  read(path: string): Promise<Buffer> {
    return new Promise((resolve, reject) => this.sftp.readFile(path, settle(resolve, reject)));
  }

  write(path: string, bytes: Buffer): Promise<void> {
    return new Promise((resolve, reject) =>
      this.sftp.writeFile(path, bytes, settle(resolve, reject)),
    );
  }

  remove(path: string): Promise<void> {
    return new Promise((resolve, reject) => this.sftp.unlink(path, settle(resolve, reject)));
  }
}

function entryType(mode: number): SftpEntry["type"] {
  const kind = mode & 0o170000;
  if (kind === 0o100000) return "file";
  if (kind === 0o040000) return "folder";
  return "other";
}

function toEntry(folder: string, item: FileEntryWithStats): SftpEntry {
  return {
    name: item.filename,
    path: folder === "/" ? `/${item.filename}` : `${folder}/${item.filename}`,
    type: entryType(item.attrs.mode),
    size_bytes: item.attrs.size,
    modified_at: item.attrs.mtime ? new Date(item.attrs.mtime * 1000).toISOString() : null,
  };
}

async function runOperation(p: SftpRequestParams, session: SftpSession, target: string) {
  switch (p.method) {
    case "LIST": {
      const items = await session.list(target);
      const entries = items
        .filter((item) => item.filename !== "." && item.filename !== "..")
        .map((item) => toEntry(target, item))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, p.max_entries ?? items.length);
      return { status: 200, path: target, entries };
    }
    case "GET": {
      const bytes = await session.read(target);
      return { status: 200, path: target, file: { filename: basename(target), bytes } };
    }
    case "PUT": {
      const bytes = p.body ?? Buffer.alloc(0);
      await session.write(target, bytes);
      return { status: 201, path: target, bytes_out: bytes.byteLength };
    }
    case "DELETE": {
      await session.remove(target);
      return { status: 204, path: target };
    }
  }
}

export async function executeSftpRequest(p: SftpRequestParams): Promise<SftpResponse> {
  const address = parseSftpAddress(p.connector.base_url);
  const target = resolveSftpPath(address.root, p.path);
  if (p.method === "DELETE") assertRemovableSftpFile(target, p.body);
  hostKeyPin(p.connector);
  const login = await resolveSftpLogin(p);
  await p.on_credential_use?.(login.snapshot);
  try {
    return await withSftpSession(p, login, (session) => runOperation(p, session, target));
  } catch (err) {
    if (err instanceof SftpStatusError) return { status: err.status, path: target };
    throw err;
  }
}

export function sftpAuthenticationFailed(err: unknown): boolean {
  return (err as { level?: unknown } | null)?.level === "client-authentication";
}

function sftpProbeErrorCode(err: unknown): NonNullable<DriverProbeResult["error_code"]> {
  if (err instanceof SftpConnectorError && err.error_code === "credential_missing")
    return "credential_missing";
  if (err instanceof SftpConnectorError || err instanceof SftpRefusal) return "credential_invalid";
  if (sftpAuthenticationFailed(err)) return "credential_invalid";
  return "unknown_upstream_error";
}

export async function probeSftpConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  credential_override?: DecryptedCredential | null;
}): Promise<DriverProbeResult> {
  const start = Date.now();
  try {
    const res = await executeSftpRequest({ ...p, method: "LIST", path: "/", max_entries: 1 });
    const latency_ms = Date.now() - start;
    if (res.status !== 200)
      return {
        ok: false,
        latency_ms,
        status: res.status,
        detail: `LIST returned status ${res.status}`,
        error_code: res.status === 403 ? "scope_insufficient" : "remote_resource_not_found",
      };
    return { ok: true, latency_ms, status: res.status };
  } catch (err) {
    const latency_ms = Date.now() - start;
    logger.warn({
      module: "connector",
      action: "sftp.probe.failed",
      connector_id: p.connector.id,
      latency_ms,
      ...errorFields(err),
    });
    const code = sftpProbeErrorCode(err);
    return {
      ok: false,
      latency_ms,
      detail: err instanceof Error ? err.message : String(err),
      error_code: code,
    };
  }
}
