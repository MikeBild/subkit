// SMB driver. Minimal LIST / GET / PUT / DELETE surface via
// @marsaud/smb2.
//
// DSN shape: smb://DOMAIN;user:pass@host/share[/subpath]
//   - DOMAIN is optional; omit the "DOMAIN;" segment for workgroup auth.
//   - `host` is the server; `share` is the SMB share name (mandatory).
//
// Per-call connection model — the @marsaud/smb2 client is not stateful
// enough to benefit from pooling for typical workflow traffic.

import SMB2 from "@marsaud/smb2";
import { instrument } from "../../observability/runtime-telemetry.ts";
import type { ConnectorView } from "../types.ts";

export type SmbCommand = "LIST" | "GET" | "PUT" | "DELETE";

interface DsnParts {
  host: string;
  share: string;
  basePath: string;
  domain: string;
  user: string;
  password: string;
}

function parseDsn(dsn: string): DsnParts {
  const url = new URL(dsn);
  if (url.protocol !== "smb:") {
    throw new Error(`smb dsn must use smb:// scheme, got ${url.protocol}`);
  }
  // username may encode "DOMAIN;user" — pull the domain off if present.
  let domain = "";
  let user = decodeURIComponent(url.username);
  const semi = user.indexOf(";");
  if (semi >= 0) {
    domain = user.slice(0, semi);
    user = user.slice(semi + 1);
  }
  // path = "/share/subpath..." — first segment is the share.
  const pathParts = url.pathname.split("/").filter((x) => x.length > 0);
  const share = pathParts[0];
  if (!share) throw new Error("smb dsn must include a share name: smb://host/share");
  const basePath = pathParts.slice(1).join("\\");
  return {
    host: url.hostname,
    share,
    basePath,
    domain,
    user,
    password: decodeURIComponent(url.password),
  };
}

function makeClient(parts: DsnParts): SMB2 {
  return new SMB2({
    share: `\\\\${parts.host}\\${parts.share}`,
    domain: parts.domain || "WORKGROUP",
    username: parts.user,
    password: parts.password,
    autoCloseTimeout: 5000,
  });
}

function toSmbPath(parts: DsnParts, p: string): string {
  const rel = p.replace(/^[/\\]+/, "").replace(/\//g, "\\");
  return parts.basePath ? `${parts.basePath}\\${rel}`.replace(/\\+/g, "\\") : rel;
}

export async function probeSmbConnector(
  connector: ConnectorView,
): Promise<{ ok: boolean; latency_ms: number; detail?: string }> {
  const start = Date.now();
  if (!connector.dsn) {
    return { ok: false, latency_ms: 0, detail: "missing dsn" };
  }
  const parts = parseDsn(connector.dsn);
  const client = makeClient(parts);
  try {
    await client.readdir(toSmbPath(parts, ""));
    return { ok: true, latency_ms: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      client.disconnect();
    } catch {
      // best-effort
    }
  }
}

export interface SmbExecuteParams {
  connector: ConnectorView;
  command: SmbCommand;
  path: string;
  body?: Buffer | string;
}

export interface SmbFileInfo {
  name: string;
  /** Size is 0 when the SMB client does not expose it on the stat result. */
  size: number;
  type: "file" | "directory" | "unknown";
  modified_at: string | null;
}

export type SmbExecuteResult =
  | { command: "LIST"; entries: SmbFileInfo[] }
  | { command: "GET"; body: string }
  | { command: "PUT"; bytes: number }
  | { command: "DELETE"; deleted: boolean };

export async function executeSmbCommand(p: SmbExecuteParams): Promise<SmbExecuteResult> {
  if (!p.connector.dsn) throw new Error("SMB connector has no dsn");
  const parts = parseDsn(p.connector.dsn);
  const client = makeClient(parts);
  const full = toSmbPath(parts, p.path);
  const putBytes =
    p.command === "PUT" && p.body !== undefined
      ? typeof p.body === "string"
        ? Buffer.byteLength(p.body, "utf8")
        : p.body.byteLength
      : undefined;
  try {
    return await instrument({
      module: "connector",
      action: "driver.smb.request",
      level: "debug",
      thresholdMs: 1000,
      fields: {
        connector_id: p.connector.id,
        op: p.command,
        ...(putBytes !== undefined ? { bytes: putBytes } : {}),
      },
      fn: () => runSmbCommand(client, p, full),
    });
  } finally {
    try {
      client.disconnect();
    } catch {
      // best-effort
    }
  }
}

async function runSmbCommand(
  client: SMB2,
  p: SmbExecuteParams,
  full: string,
): Promise<SmbExecuteResult> {
  if (p.command === "LIST") {
    const names = await client.readdir(full);
    const entries: SmbFileInfo[] = await Promise.all(
      names.map(async (name) => {
        const childPath = full ? `${full}\\${name}` : name;
        try {
          const stat = await client.stat(childPath);
          return {
            name,
            size: 0,
            type: stat.isDirectory() ? "directory" : ("file" as const),
            modified_at: stat.mtime ? new Date(stat.mtime).toISOString() : null,
          };
        } catch {
          return { name, size: 0, type: "unknown" as const, modified_at: null };
        }
      }),
    );
    return { command: "LIST", entries };
  }
  if (p.command === "GET") {
    const buf = await client.readFile(full);
    return { command: "GET", body: buf.toString("utf8") };
  }
  if (p.command === "PUT") {
    if (p.body === undefined) throw new Error("PUT requires 'body'");
    const buf = typeof p.body === "string" ? Buffer.from(p.body, "utf8") : p.body;
    await client.writeFile(full, buf);
    return { command: "PUT", bytes: buf.byteLength };
  }
  if (p.command === "DELETE") {
    await client.unlink(full);
    return { command: "DELETE", deleted: true };
  }
  // Exhaustiveness guard — TypeScript can't always infer the switch is
  // total, so an explicit never-branch keeps the return type tight.
  const _never: never = p.command;
  throw new Error(`unsupported smb command: ${String(_never)}`);
}
