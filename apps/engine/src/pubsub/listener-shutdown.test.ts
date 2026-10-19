import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.ts";

const clients: FakeClient[] = [];
class FakeClient extends EventEmitter {
  constructor() {
    super();
    clients.push(this);
  }
  async connect() {}
  async query() {
    return { rows: [] };
  }
  async end() {}
}
mock.module("pg", () => ({ default: { Client: FakeClient, Pool: class {} } }));
const { PubSubListener } = await import("./listener.ts");
const { PubSubEmitter } = await import("./emitter.ts");
const { events, outboxCursors } = await import("../db/schema/index.ts");
const { LISTENER_CHANNELS } = await import("./types.ts");
const channel = LISTENER_CHANNELS[0];
if (!channel) throw new Error("channel_fixture_missing");

function databaseFixture(holdRead = false) {
  const readEntered = Promise.withResolvers<void>();
  const readRelease = Promise.withResolvers<void>();
  let pages = 0;
  const writes: unknown[][] = [];
  const rows = [1, 2].map((id) => ({
    id,
    tenant_id: null,
    channel,
    type: "fixture",
    payload: {},
    created_at: new Date(0),
  }));
  const db = {
    select() {
      return {
        from(table: unknown) {
          const query = {
            where() {
              return query;
            },
            orderBy() {
              return query;
            },
            async limit() {
              if (table === outboxCursors) return [{ last_seen_id: 0 }];
              if (table !== events) throw new Error("unexpected_table");
              pages++;
              readEntered.resolve();
              if (holdRead) await readRelease.promise;
              return rows;
            },
          };
          return query;
        },
      };
    },
    async execute(query: SQL) {
      writes.push(new PgDialect().sqlToQuery(query).params);
      return [];
    },
  } as unknown as Db;
  return { db, readEntered, readRelease, writes, pages: () => pages };
}

test("stop drains the admitted handler without dispatching prefetched rows or admitting another page", async () => {
  const fixture = databaseFixture();
  const emitter = new PubSubEmitter();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seen: number[] = [];
  emitter.on(channel, async (event) => {
    seen.push(event.id);
    entered.resolve();
    await release.promise;
  });
  const listener = new PubSubListener({
    db: fixture.db,
    connectionString: "postgres://fixture",
    channels: [channel],
    catchUpBatchSize: 2,
    emitter,
  });
  const starting = listener.start();
  await entered.promise;
  let stopped = false;
  const stopping = listener.stop().then(() => {
    stopped = true;
  });
  clients.at(-1)?.emit("notification", { channel, payload: "3" });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release.resolve();
  await Promise.all([starting, stopping]);
  expect(seen).toEqual([1]);
  expect(fixture.pages()).toBe(1);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]?.[2]).toBe(1);
  expect(listener.isConnected()).toBe(false);
});

test("stop waits an admitted page read and never dispatches its returned rows", async () => {
  const fixture = databaseFixture(true);
  const emitter = new PubSubEmitter();
  let calls = 0;
  emitter.on(channel, () => {
    calls++;
  });
  const listener = new PubSubListener({
    db: fixture.db,
    connectionString: "postgres://fixture",
    channels: [channel],
    emitter,
  });
  const starting = listener.start();
  await fixture.readEntered.promise;
  let stopped = false;
  const stopping = listener.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  fixture.readRelease.resolve();
  await Promise.all([starting, stopping]);
  expect(calls).toBe(0);
  expect(fixture.pages()).toBe(1);
  expect(fixture.writes).toHaveLength(0);
});
