// SFTP driver. Minimal LIST / GET / PUT / DELETE surface via
// ssh2-sftp-client.
//
// DSN shape: sftp://user:pass@host[:port][/basePath]
//
// Per-call connection model — SFTP handshakes are expensive but most
// workflows hit the server sporadically. One connection per operation
// keeps the lifecycle simple; pool later if volume demands.

import SftpClient from "ssh2-sftp-client";
import type { ConnectorView } from "../types.ts";

export type SftpCommand = "LIST" | "GET" | "PUT" | "DELETE";

interface DsnParts {
  host: string;
  port: number;
  user: string;
  password: string;
  basePath: string;
}

function parseDsn(dsn: string): DsnParts {
  const url = new URL(dsn);
  if (url.protocol !== "sftp:" && url.protocol !== "ssh:") {
    throw new Error(`sftp dsn must use sftp:// or ssh:// scheme, got ${url.protocol}`);
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 22,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    basePath: url.pathname || "/",
  };
}

async function withClient<T>(
  connector: ConnectorView,
  fn: (client: SftpClient) => Promise<T>,
): Promise<T> {
  if (!connector.dsn) {
    throw new Error(`SFTP connector ${connector.id} has no dsn; cannot connect`);
  }
  const parts = parseDsn(connector.dsn);
  const client = new SftpClient();
  try {
    await client.connect({
      host: parts.host,
      port: parts.port,
      username: parts.user,
      password: parts.password,
      readyTimeout: 30_000,
    });
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch {
      // best-effort
    }
  }
}

export async function probeSftpConnector(
  connector: ConnectorView,
): Promise<{ ok: boolean; latency_ms: number; detail?: string }> {
  const start = Date.now();
  try {
    await withClient(connector, async (client) => {
      await client.cwd();
    });
    return { ok: true, latency_ms: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface SftpExecuteParams {
  connector: ConnectorView;
  command: SftpCommand;
  path: string;
  body?: Buffer | string;
}

export interface SftpFileInfo {
  name: string;
  size: number;
  type: "file" | "directory" | "symlink" | "unknown";
  modified_at: string | null;
}

export type SftpExecuteResult =
  | { command: "LIST"; entries: SftpFileInfo[] }
  | { command: "GET"; body: string }
  | { command: "PUT"; bytes: number }
  | { command: "DELETE"; deleted: boolean };

function resolvePath(parts: DsnParts, path: string): string {
  if (path.startsWith("/")) return path;
  return `${parts.basePath.replace(/\/$/, "")}/${path}`.replace(/\/+/g, "/");
}

function mapFileType(raw: string): SftpFileInfo["type"] {
  switch (raw) {
    case "d":
      return "directory";
    case "-":
      return "file";
    case "l":
      return "symlink";
    default:
      return "unknown";
  }
}

export async function executeSftpCommand(p: SftpExecuteParams): Promise<SftpExecuteResult> {
  if (!p.connector.dsn) {
    throw new Error(`SFTP connector ${p.connector.id} has no DSN configured`);
  }
  const parts = parseDsn(p.connector.dsn);
  const full = resolvePath(parts, p.path);
  return await withClient(p.connector, async (client) => {
    switch (p.command) {
      case "LIST": {
        const entries = await client.list(full);
        return {
          command: "LIST" as const,
          entries: entries.map((e) => ({
            name: e.name,
            size: e.size,
            type: mapFileType(e.type),
            modified_at: e.modifyTime ? new Date(e.modifyTime).toISOString() : null,
          })),
        };
      }
      case "GET": {
        const buf = (await client.get(full)) as Buffer;
        return { command: "GET" as const, body: buf.toString("utf8") };
      }
      case "PUT": {
        if (p.body === undefined) throw new Error("PUT requires 'body'");
        const buf = typeof p.body === "string" ? Buffer.from(p.body, "utf8") : p.body;
        await client.put(buf, full);
        return { command: "PUT" as const, bytes: buf.byteLength };
      }
      case "DELETE": {
        await client.delete(full);
        return { command: "DELETE" as const, deleted: true };
      }
    }
  });
}
