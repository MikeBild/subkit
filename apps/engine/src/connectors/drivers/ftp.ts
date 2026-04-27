// FTP driver. Minimal LIST / GET / PUT / DELETE surface via basic-ftp.
//
// DSN shape: ftp://user:pass@host[:port][/basePath]
//
// Per-call connection model: FTP connections are cheap but stateful,
// and most workflows hit the server sporadically. We open a client
// per operation, run the command, and close it. If volume warrants,
// swap to a pooled client later.

import { Writable } from "node:stream";
import * as ftp from "basic-ftp";
import type { ConnectorView } from "../types.ts";

export type FtpCommand = "LIST" | "GET" | "PUT" | "DELETE";

interface DsnParts {
  host: string;
  port: number;
  user: string;
  password: string;
  basePath: string;
  secure: boolean;
}

function parseDsn(dsn: string): DsnParts {
  const url = new URL(dsn);
  if (url.protocol !== "ftp:" && url.protocol !== "ftps:") {
    throw new Error(`ftp dsn must use ftp:// or ftps:// scheme, got ${url.protocol}`);
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 21,
    user: decodeURIComponent(url.username) || "anonymous",
    password: decodeURIComponent(url.password) || "",
    basePath: url.pathname || "/",
    secure: url.protocol === "ftps:",
  };
}

async function withClient<T>(
  connector: ConnectorView,
  fn: (client: ftp.Client) => Promise<T>,
): Promise<T> {
  if (!connector.dsn) {
    throw new Error(`FTP connector ${connector.id} has no dsn; cannot connect`);
  }
  const parts = parseDsn(connector.dsn);
  const client = new ftp.Client(30_000);
  client.ftp.verbose = false;
  try {
    await client.access({
      host: parts.host,
      port: parts.port,
      user: parts.user,
      password: parts.password,
      secure: parts.secure,
    });
    return await fn(client);
  } finally {
    client.close();
  }
}

export async function probeFtpConnector(
  connector: ConnectorView,
): Promise<{ ok: boolean; latency_ms: number; detail?: string }> {
  const start = Date.now();
  try {
    await withClient(connector, async (client) => {
      await client.pwd();
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

export interface FtpExecuteParams {
  connector: ConnectorView;
  command: FtpCommand;
  /** Remote path; relative paths resolve against DSN basePath. */
  path: string;
  /** PUT payload, UTF-8 text or binary buffer. */
  body?: Buffer | string;
}

export interface FtpFileInfo {
  name: string;
  size: number;
  type: "file" | "directory" | "symlink" | "unknown";
  modified_at: string | null;
}

export type FtpExecuteResult =
  | { command: "LIST"; entries: FtpFileInfo[] }
  | { command: "GET"; body: string }
  | { command: "PUT"; bytes: number }
  | { command: "DELETE"; deleted: boolean };

function resolvePath(parts: DsnParts, path: string): string {
  if (path.startsWith("/")) return path;
  return `${parts.basePath.replace(/\/$/, "")}/${path}`.replace(/\/+/g, "/");
}

function mapFileType(t: ftp.FileType): FtpFileInfo["type"] {
  switch (t) {
    case ftp.FileType.Directory:
      return "directory";
    case ftp.FileType.File:
      return "file";
    case ftp.FileType.SymbolicLink:
      return "symlink";
    default:
      return "unknown";
  }
}

export async function executeFtpCommand(p: FtpExecuteParams): Promise<FtpExecuteResult> {
  if (!p.connector.dsn) {
    throw new Error(`FTP connector ${p.connector.id} has no DSN configured`);
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
            modified_at: e.modifiedAt ? e.modifiedAt.toISOString() : null,
          })),
        };
      }
      case "GET": {
        const chunks: Buffer[] = [];
        const sink = new Writable({
          write(chunk, _enc, cb) {
            chunks.push(Buffer.from(chunk));
            cb();
          },
        });
        await client.downloadTo(sink, full);
        return { command: "GET" as const, body: Buffer.concat(chunks).toString("utf8") };
      }
      case "PUT": {
        if (p.body === undefined) throw new Error("PUT requires 'body'");
        const { Readable } = await import("node:stream");
        const buf = typeof p.body === "string" ? Buffer.from(p.body, "utf8") : p.body;
        const src = Readable.from(buf);
        await client.uploadFrom(src, full);
        return { command: "PUT" as const, bytes: buf.byteLength };
      }
      case "DELETE": {
        await client.remove(full);
        return { command: "DELETE" as const, deleted: true };
      }
    }
  });
}
