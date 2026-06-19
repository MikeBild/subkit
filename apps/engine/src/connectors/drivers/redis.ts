// Redis driver. Minimal GET / SET / DEL / PUBLISH surface via node-redis.
//
// Pool lifecycle: one long-lived client per connector id. The map lives
// at module scope so repeated calls share the same connection. Tests
// call `closeAllRedisClients()` to reset.
//
// Commands exposed:
//   GET <key>                 → string | null
//   SET <key> <value> [ttl]   → "OK"
//   DEL <key>                 → count deleted
//   PUBLISH <channel> <msg>   → subscriber count
//   INCR <key>                → incremented value
//   EXPIRE <key> <seconds>    → 1 if set, 0 if key did not exist
//
// Connection string shape: redis://[:password@]host[:port][/db]

import { createClient, type RedisClientType } from "redis";
import { logger } from "../../logging/logger.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import type { ConnectorView } from "../types.ts";
import type { DriverProbeResult } from "./index.ts";
import { classifyRedisProbeError } from "./probe-classify.ts";

export type RedisCommand = "GET" | "SET" | "DEL" | "PUBLISH" | "INCR" | "EXPIRE";

const clients = new Map<string, RedisClientType>();

function clientKey(connector: ConnectorView): string {
  return `${connector.id}:${connector.environment}`;
}

async function getClient(connector: ConnectorView): Promise<RedisClientType> {
  if (!connector.dsn) {
    throw new Error(`Redis connector ${connector.id} has no dsn; cannot connect`);
  }
  const key = clientKey(connector);
  const existing = clients.get(key);
  if (existing?.isOpen) return existing;

  const client = createClient({ url: connector.dsn }) as RedisClientType;
  client.on("error", (err: Error) => {
    logger.error({
      module: "connectors",
      action: "redis.client.error",
      msg: "redis driver client emitted error",
      connector_id: connector.id,
      error: err.message,
    });
  });
  await client.connect();
  clients.set(key, client);
  return client;
}

export async function probeRedisConnector(connector: ConnectorView): Promise<DriverProbeResult> {
  const start = Date.now();
  if (!connector.dsn) {
    return {
      ok: false,
      latency_ms: 0,
      detail: "connector has no dsn",
      error_code: "credential_missing",
    };
  }
  try {
    const client = await getClient(connector);
    const pong = await client.ping();
    return {
      ok: pong === "PONG",
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
      error_code: classifyRedisProbeError(err),
    };
  }
}

export interface RedisExecuteParams {
  connector: ConnectorView;
  command: RedisCommand;
  key?: string;
  value?: string;
  channel?: string;
  message?: string;
  /** SET-with-TTL (seconds) or EXPIRE seconds. */
  ttl_seconds?: number;
}

export interface RedisExecuteResult {
  command: RedisCommand;
  result: string | number | null;
}

export async function executeRedisCommand(p: RedisExecuteParams): Promise<RedisExecuteResult> {
  const client = await getClient(p.connector);
  return await instrument({
    module: "connector",
    action: "driver.redis.request",
    level: "debug",
    thresholdMs: 1000,
    fields: { connector_id: p.connector.id, op: p.command },
    fn: () => runRedisCommand(client, p),
  });
}

async function runRedisCommand(
  client: RedisClientType,
  p: RedisExecuteParams,
): Promise<RedisExecuteResult> {
  switch (p.command) {
    case "GET": {
      if (!p.key) throw new Error("GET requires 'key'");
      const v = await client.get(p.key);
      return { command: "GET", result: v };
    }
    case "SET": {
      if (!p.key) throw new Error("SET requires 'key'");
      if (p.value === undefined) throw new Error("SET requires 'value'");
      const out = p.ttl_seconds
        ? await client.set(p.key, p.value, { EX: p.ttl_seconds })
        : await client.set(p.key, p.value);
      return { command: "SET", result: out ?? null };
    }
    case "DEL": {
      if (!p.key) throw new Error("DEL requires 'key'");
      const n = await client.del(p.key);
      return { command: "DEL", result: n };
    }
    case "PUBLISH": {
      if (!p.channel) throw new Error("PUBLISH requires 'channel'");
      if (p.message === undefined) throw new Error("PUBLISH requires 'message'");
      const n = await client.publish(p.channel, p.message);
      return { command: "PUBLISH", result: n };
    }
    case "INCR": {
      if (!p.key) throw new Error("INCR requires 'key'");
      const n = await client.incr(p.key);
      return { command: "INCR", result: n };
    }
    case "EXPIRE": {
      if (!p.key) throw new Error("EXPIRE requires 'key'");
      if (!p.ttl_seconds) throw new Error("EXPIRE requires 'ttl_seconds'");
      const ok = await client.expire(p.key, p.ttl_seconds);
      return { command: "EXPIRE", result: ok ? 1 : 0 };
    }
  }
}

export async function closeAllRedisClients(): Promise<void> {
  const all = Array.from(clients.values());
  clients.clear();
  await Promise.all(
    all.map(async (c) => {
      try {
        if (c.isOpen) await c.quit();
      } catch {
        // best-effort shutdown
      }
    }),
  );
}
