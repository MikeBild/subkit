// Dedicated pg.Client LISTEN loop with reconnect + outbox catch-up.
//
// Lifecycle:
//   start() -> connectOnce() -> catchUpAll() -> LISTEN every channel ->
//     on notification: parse id, hydrate row from events, dispatch
//     on error / end: schedule a reconnect with exponential backoff.
//
// Catch-up runs *before* LISTEN is issued on every (re)connect. Any
// events that arrive via NOTIFY while catch-up is running are queued in
// memory and dispatched after catch-up so ordering is preserved.
//
// The watermark per channel is stored in `outbox_cursors` keyed by the
// listener_id + channel composite so multiple listener processes can
// coexist.

import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import pg from "pg";
import type { Db } from "../db/client.ts";
import { events as eventsTable, outboxCursors } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { setOutboxCursorLag } from "../observability/instrumentation.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { globalEmitter, type PubSubEmitter } from "./emitter.ts";
import {
  type EventEnvelope,
  type EventHandler,
  LISTENER_CHANNELS,
  type OutboxChannel,
} from "./types.ts";

const { Client } = pg;

export interface ListenerOptions {
  connectionString: string;
  /** Logical id used for cursor rows. Defaults to `engine-<pid>`. */
  listenerId?: string;
  /** In-process emitter to dispatch into. Defaults to the module-scoped one. */
  emitter?: PubSubEmitter;
  /** Drizzle handle used to read events + upsert cursors. */
  db: Db;
  /** Optional channel subset, primarily for tests. */
  channels?: readonly OutboxChannel[];
  /** Max rows to drain per catch-up pass. */
  catchUpBatchSize?: number;
}

const DEFAULT_CATCH_UP_BATCH = 1000;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;
// Stable outbox-consumer id, shared across restarts so the cursor persists.
const DEFAULT_LISTENER_ID = "engine";

export class PubSubListener {
  private client: pg.Client | null = null;
  private connected = false;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = BACKOFF_START_MS;
  /** Events that arrived via NOTIFY during catch-up. Flushed after. */
  private pendingDuringCatchup: Map<OutboxChannel, number[]> = new Map();
  private catchingUp = false;
  private readonly channels: readonly OutboxChannel[];
  private readonly emitter: PubSubEmitter;
  private readonly listenerId: string;

  constructor(private readonly opts: ListenerOptions) {
    this.channels = opts.channels ?? LISTENER_CHANNELS;
    this.emitter = opts.emitter ?? globalEmitter;
    // STABLE consumer id (not `engine-${pid}`). A per-pid id meant every
    // restart minted a fresh id with no cursor row → loadCursor returned 0 →
    // the entire outbox was re-dispatched, re-firing every historical
    // notification/webhook. A stable id reuses its cursor across restarts.
    // (Single-process deployment; a multi-instance rollout additionally
    // needs handler idempotency — see the fanout dedup key.)
    this.listenerId = opts.listenerId ?? DEFAULT_LISTENER_ID;
  }

  on<P = unknown>(channel: OutboxChannel, handler: EventHandler<P>): () => void {
    return this.emitter.on(channel, handler);
  }
  off<P = unknown>(channel: OutboxChannel, handler: EventHandler<P>): void {
    this.emitter.off(channel, handler);
  }

  /** Begin connecting. Resolves once the first connection + catch-up is complete. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connectOnce();
  }

  /** Cleanly disconnect and stop reconnecting. Safe to call multiple times. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        // Best-effort UNLISTEN before disconnecting.
        await this.client.query("UNLISTEN *").catch(() => {});
        await this.client.end();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    this.connected = false;
    logger.info({
      module: "pubsub",
      action: "listener.stopped",
      msg: "pub/sub listener stopped",
      listener_id: this.listenerId,
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  getListenerId(): string {
    return this.listenerId;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    logger.warn({
      module: "pubsub",
      action: "listener.reconnect_scheduled",
      msg: "scheduling pub/sub listener reconnect",
      listener_id: this.listenerId,
      delay_ms: delay,
    });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connectOnce();
      } catch (err) {
        logger.error({
          module: "pubsub",
          action: "listener.reconnect_failed",
          msg: "pub/sub reconnect attempt failed",
          listener_id: this.listenerId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({ connectionString: this.opts.connectionString });
    client.on("error", (err) => {
      logger.error({
        module: "pubsub",
        action: "listener.client_error",
        msg: "LISTEN pg client emitted error",
        listener_id: this.listenerId,
        error: err.message,
      });
      this.connected = false;
      this.client = null;
      this.backoffMs = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_START_MS, this.backoffMs * 2));
      this.scheduleReconnect();
    });
    client.on("end", () => {
      if (this.stopped) return;
      logger.warn({
        module: "pubsub",
        action: "listener.client_end",
        msg: "LISTEN pg client ended",
        listener_id: this.listenerId,
      });
      this.connected = false;
      this.client = null;
      this.scheduleReconnect();
    });
    client.on("notification", (msg) => {
      void this.onNotification(msg);
    });

    await client.connect();
    this.client = client;

    // Catch up before LISTEN so we don't miss any rows written while we
    // were disconnected.
    this.catchingUp = true;
    try {
      await this.catchUpAll();
    } finally {
      this.catchingUp = false;
    }

    for (const channel of this.channels) {
      // pg channel names cannot contain `.`; we quote them.
      await client.query(`LISTEN "${channel}"`);
    }

    // Drain anything that arrived during catch-up.
    const pending = this.pendingDuringCatchup;
    this.pendingDuringCatchup = new Map();
    for (const [channel, ids] of pending) {
      if (ids.length === 0) continue;
      const maxId = Math.max(...ids);
      await this.catchUpChannel(channel, maxId);
    }

    this.connected = true;
    this.backoffMs = BACKOFF_START_MS;

    logger.info({
      module: "pubsub",
      action: "listener.connected",
      msg: "pub/sub listener connected",
      listener_id: this.listenerId,
      channels: this.channels.length,
    });
  }

  private async onNotification(msg: pg.Notification): Promise<void> {
    if (!msg.channel) return;
    const channel = msg.channel as OutboxChannel;
    if (!this.channels.includes(channel)) return;
    const payload = msg.payload ?? "";
    const id = Number.parseInt(payload, 10);
    if (!Number.isFinite(id) || id <= 0) {
      logger.warn({
        module: "pubsub",
        action: "listener.bad_payload",
        msg: "NOTIFY payload is not an event id",
        channel,
        payload,
      });
      return;
    }
    if (this.catchingUp) {
      const arr = this.pendingDuringCatchup.get(channel) ?? [];
      arr.push(id);
      this.pendingDuringCatchup.set(channel, arr);
      return;
    }
    // Drain anything strictly newer than the cursor up through (and
    // including) this id. That way, if an earlier event slipped through
    // without being observed, we pick it up here.
    await this.catchUpChannel(channel, id);
  }

  /** Catch up a single channel from its stored cursor up to at least `untilId`. */
  private async catchUpChannel(channel: OutboxChannel, untilId?: number): Promise<void> {
    const db = this.opts.db;
    const cursor = await this.loadCursor(channel);
    const maxBatch = this.opts.catchUpBatchSize ?? DEFAULT_CATCH_UP_BATCH;
    // tenant-filter:exempt — outbox/listener sweeps every tenant; row carries tenant_id forward
    const rows = await db
      .select()
      .from(eventsTable)
      .where(and(eq(eventsTable.channel, channel), gt(eventsTable.id, cursor)))
      .orderBy(asc(eventsTable.id))
      .limit(maxBatch);
    if (rows.length === 0) return;
    for (const row of rows) {
      const envelope: EventEnvelope = {
        id: row.id,
        tenant_id: row.tenant_id,
        channel: row.channel as OutboxChannel,
        type: row.type,
        payload: row.payload,
        created_at: row.created_at,
      };
      await instrument({
        module: "pubsub",
        action: "event.dispatch",
        level: "debug",
        thresholdMs: 250,
        fields: { channel, event_type: envelope.type, event_id: envelope.id },
        fn: () => this.emitter.dispatch(envelope),
      });
    }
    const lastId = rows[rows.length - 1]?.id ?? cursor;
    await this.saveCursor(channel, lastId);
    // If there might be more rows (we hit the batch limit or the target
    // is still ahead), recurse.
    const needMore = rows.length === maxBatch || (untilId !== undefined && lastId < untilId);
    if (needMore) {
      await this.catchUpChannel(channel, untilId);
    }
  }

  private async catchUpAll(): Promise<void> {
    for (const channel of this.channels) {
      await this.catchUpChannel(channel);
    }
  }

  private async loadCursor(channel: OutboxChannel): Promise<number> {
    const db = this.opts.db;
    // tenant-filter:exempt — outbox/listener sweeps every tenant; row carries tenant_id forward
    const rows = await db
      .select()
      .from(outboxCursors)
      .where(
        and(eq(outboxCursors.listener_id, this.listenerId), eq(outboxCursors.channel, channel)),
      )
      .limit(1);
    if (rows[0]) return rows[0].last_seen_id;
    // No cursor row for this consumer yet. Seeding from 0 would re-dispatch
    // the entire outbox once (e.g. the first boot after adopting the stable
    // id, or any brand-new consumer). Instead resume from the furthest
    // watermark ANY prior consumer reached on this channel — so a fresh
    // consumer starts at "now", not at the dawn of history. (NULL → 0 only
    // on a genuinely empty cursor table.)
    // tenant-filter:exempt — outbox/listener sweeps every tenant; the cursor
    // watermark is a per-channel global, not tenant-scoped.
    const [hwm] = await db
      .select({ m: max(outboxCursors.last_seen_id) })
      .from(outboxCursors)
      .where(eq(outboxCursors.channel, channel));
    return hwm?.m ?? 0;
  }

  private async saveCursor(channel: OutboxChannel, lastId: number): Promise<void> {
    const db = this.opts.db;
    // Upsert via ON CONFLICT on the composite pk.
    await db.execute(sql`
      INSERT INTO "outbox_cursors" ("listener_id", "channel", "last_seen_id", "updated_at")
      VALUES (${this.listenerId}, ${channel}, ${lastId}, NOW())
      ON CONFLICT ("listener_id", "channel")
      DO UPDATE SET "last_seen_id" = EXCLUDED."last_seen_id", "updated_at" = NOW()
    `);
    // Approximate "lag" = head row id - cursor id. Cheap query against
    // the indexed channel column.
    try {
      // tenant-filter:exempt — outbox/listener sweeps every tenant; row carries tenant_id forward
      const headRows = await db
        .select({ max_id: sql<number>`COALESCE(MAX(id), 0)` })
        .from(eventsTable)
        .where(eq(eventsTable.channel, channel));
      const head = Number(headRows[0]?.max_id ?? 0);
      setOutboxCursorLag({
        listener_id: this.listenerId,
        channel,
        lag: Math.max(0, head - lastId),
      });
    } catch {
      /* ignore — gauges are best-effort */
    }
  }
}

// Module-scoped shared listener so the rest of the engine can
// `subscribe(channel, handler)` without thinking about lifecycle.
let _listener: PubSubListener | null = null;

export async function startListener(opts: ListenerOptions): Promise<PubSubListener> {
  if (_listener) return _listener;
  _listener = new PubSubListener(opts);
  await _listener.start();
  return _listener;
}

export function getListener(): PubSubListener {
  if (!_listener) throw new Error("pub/sub listener has not been started");
  return _listener;
}

export async function stopListener(): Promise<void> {
  if (!_listener) return;
  const l = _listener;
  _listener = null;
  await l.stop();
}
