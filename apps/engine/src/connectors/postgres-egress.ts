import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { checkServerIdentity } from "node:tls";
import pg from "pg";
import {
  assertEgressAllowed,
  EgressBlockedError,
  type EgressGuardContext,
  grantedLocalTarget,
  resolveAllowedEgressAddresses,
  resolveEgressGuardMode,
  resolveTenantEgressContext,
} from "./egress-guard.ts";
import { ownTargetScope } from "./local-egress.ts";

function rejectLocalSslFiles(dsn: string): void {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new EgressBlockedError("postgres_dsn_invalid", "");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new EgressBlockedError("postgres_dsn_invalid", "");
  for (const [name] of url.searchParams) {
    if (["sslcert", "sslkey", "sslrootcert"].includes(name.toLowerCase()))
      throw new EgressBlockedError("postgres_local_ssl_file_blocked", "");
  }
}

function strictConnectionString(dsn: string): string {
  rejectLocalSslFiles(dsn);
  const url = new URL(dsn);
  const user = url.searchParams.getAll("user").at(-1) || decodeURIComponent(url.username);
  const host = url.searchParams.getAll("host").at(-1) || url.hostname;
  if (!user || !host) throw new EgressBlockedError("postgres_explicit_target_required", "");
  url.searchParams.set("user", user);
  url.searchParams.set("host", host);
  url.searchParams.set("port", url.searchParams.getAll("port").at(-1) || url.port || "5432");
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.delete("uselibpqcompat");
  return url.href;
}

export function postgresDsnTarget(dsn: string): URL {
  rejectLocalSslFiles(dsn);
  const client = new pg.Client({ connectionString: strictConnectionString(dsn) });
  const hostname = client.host.startsWith("/")
    ? "localhost"
    : client.host.includes(":") && !client.host.startsWith("[")
      ? `[${client.host}]`
      : client.host;
  return new URL(`postgresql://${hostname}:${client.port}/`);
}

function pinnedStream(target: URL, context: EgressGuardContext, originalHost: string): Socket {
  const socket = new Socket();
  const connect = socket.connect.bind(socket);
  const expectedHost = originalHost;
  const expectedPort = Number(target.port || "5432");
  socket.connect = ((port: unknown, host: unknown) => {
    void (async () => {
      if (port !== expectedPort || host !== expectedHost)
        throw new EgressBlockedError("postgres_socket_target_mismatch", expectedHost);
      const addresses = await resolveAllowedEgressAddresses(target, context);
      const address = addresses[0];
      if (!address) throw new EgressBlockedError("dns_resolution_failed", expectedHost);
      if (!socket.destroyed)
        connect({ host: address.address, family: address.family, port: expectedPort });
    })().catch((error: unknown) => {
      if (!socket.destroyed)
        socket.destroy(error instanceof Error ? error : new Error("postgres_connection_blocked"));
    });
    return socket;
  }) as Socket["connect"];
  return socket;
}

export async function postgresPoolConfiguration(
  dsn: string,
  context: EgressGuardContext = {},
  options: pg.PoolConfig = {},
) {
  const ownScope = context.local_mcp ? undefined : ownTargetScope(postgresDsnTarget(dsn));
  const resolved = await resolveTenantEgressContext(
    ownScope ? { ...context, local_mcp: ownScope } : context,
  );
  const mode = resolveEgressGuardMode(resolved);
  const key = createHash("sha256").update(dsn).update(mode).digest("hex");
  if (mode === "permissive")
    return { options: { ...options, connectionString: dsn }, context: resolved, key };
  if (grantedLocalTarget(postgresDsnTarget(dsn), resolved))
    return { options: { ...options, connectionString: dsn }, context: resolved, key };
  rejectLocalSslFiles(dsn);
  const client = new pg.Client({ connectionString: strictConnectionString(dsn) });
  const target = postgresDsnTarget(dsn);
  assertEgressAllowed(target, resolved);
  const parameters = Reflect.get(client, "connectionParameters") as pg.ClientConfig;
  const explicit = new URL(dsn);
  const password =
    explicit.searchParams.getAll("password").at(-1) || decodeURIComponent(explicit.password);
  const config: pg.PoolConfig = {
    ...parameters,
    ...options,
    user: client.user,
    database: explicit.pathname.slice(1) ? decodeURI(explicit.pathname.slice(1)) : client.user,
    password: password || (() => ""),
    host: client.host,
    port: client.port,
    ssl: { rejectUnauthorized: true, checkServerIdentity },
    stream: () => pinnedStream(target, resolved, client.host),
  };
  delete config.connectionString;
  return { options: config, context: resolved, key };
}

export async function assertPostgresDsnEgress(
  dsn: string,
  context: EgressGuardContext = {},
): Promise<void> {
  const prepared = await postgresPoolConfiguration(dsn, context);
  if (resolveEgressGuardMode(prepared.context) === "strict")
    await resolveAllowedEgressAddresses(postgresDsnTarget(dsn), prepared.context);
}
