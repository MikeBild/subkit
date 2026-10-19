import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import pg from "pg";
import type { Db } from "../db/client.ts";
import {
  databaseClientOptions,
  databaseConnectionSettings,
  initializeDatabaseSession,
} from "../db/connection-options.ts";
import { events as eventsTable, outboxCursors } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";
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
  listenerId?: string;
  emitter?: PubSubEmitter;
  db: Db;
  channels?: readonly OutboxChannel[];
  catchUpBatchSize?: number;
}

const DEFAULT_CATCH_UP_BATCH = 1000;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const DEFAULT_LISTENER_ID = "engine";

export class PubSubListener {
  private client: pg.Client | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = BACKOFF_START_MS;
  private pendingDuringCatchup: Map<OutboxChannel, number[]> = new Map();
  private catchingUp = false;
  private inflight = new Set<Promise<void>>();
  private readonly channels: readonly OutboxChannel[];
  private readonly emitter: PubSubEmitter;
  private readonly listenerId: string;

  constructor(private readonly opts: ListenerOptions) {
    this.channels = opts.channels ?? LISTENER_CHANNELS;
    this.emitter = opts.emitter ?? globalEmitter;
    this.listenerId = opts.listenerId ?? DEFAULT_LISTENER_ID;
  }

  on<P = unknown>(channel: OutboxChannel, handler: EventHandler<P>): () => void {
    return this.emitter.on(channel, handler);
  }
  off<P = unknown>(channel: OutboxChannel, handler: EventHandler<P>): void {
    this.emitter.off(channel, handler);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        await this.client.end();
      } catch {}
      this.client = null;
    }
    if (this.connecting) await this.connecting.catch(() => {});
    if (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
      this.inflight.clear();
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
          ...errorFields(err),
        });
        this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private async connectOnce(): Promise<void> {
    if (this.connecting) return this.connecting;
    const pending = this.establishConnection();
    this.connecting = pending;
    try {
      await pending;
    } finally {
      if (this.connecting === pending) this.connecting = null;
    }
  }

  private async establishConnection(): Promise<void> {
    if (this.stopped || this.connected) return;
    const settings = databaseConnectionSettings();
    const client = new Client(databaseClientOptions(this.opts.connectionString, settings));
    this.client = client;
    const disconnect = (err?: Error) => {
      if (this.client !== client) return;
      this.connected = false;
      this.client = null;
      void client.end().catch(() => {});
      if (err) {
        logger.error({
          module: "pubsub",
          action: "listener.client_error",
          msg: "LISTEN pg client emitted error",
          listener_id: this.listenerId,
          ...errorFields(err),
        });
      }
      this.scheduleReconnect();
    };
    client.on("error", disconnect);
    client.on("end", () => disconnect());
    client.on("notification", (msg) => {
      void this.onNotification(msg).catch((err) => {
        logger.error({
          module: "pubsub",
          action: "listener.notification_failed",
          msg: "pub/sub notification processing failed",
          listener_id: this.listenerId,
          ...errorFields(err),
        });
      });
    });

    try {
      await client.connect();
      await initializeDatabaseSession(client, settings);
      if (this.stopped || this.client !== client) return;
      this.catchingUp = true;
      for (const channel of this.channels) {
        await client.query(`LISTEN "${channel}"`);
      }
      await this.catchUpAll();
      while (this.pendingDuringCatchup.size > 0) {
        const pending = this.pendingDuringCatchup;
        this.pendingDuringCatchup = new Map();
        for (const [channel, ids] of pending) {
          if (ids.length > 0) await this.catchUpChannel(channel, Math.max(...ids));
        }
      }
      if (this.stopped || this.client !== client) return;
      this.connected = true;
      this.backoffMs = BACKOFF_START_MS;
      logger.info({
        module: "pubsub",
        action: "listener.connected",
        msg: "pub/sub listener connected",
        listener_id: this.listenerId,
        channels: this.channels.length,
      });
    } finally {
      this.catchingUp = false;
      if (!this.connected || this.client !== client) {
        if (this.client === client) this.client = null;
        await client.end().catch(() => {});
      }
    }
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
    const drain = this.catchUpChannel(channel, id);
    this.inflight.add(drain);
    try {
      await drain;
    } finally {
      this.inflight.delete(drain);
    }
  }

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
    await db.execute(sql`
      INSERT INTO "outbox_cursors" ("listener_id", "channel", "last_seen_id", "updated_at")
      VALUES (${this.listenerId}, ${channel}, ${lastId}, NOW())
      ON CONFLICT ("listener_id", "channel")
      DO UPDATE SET "last_seen_id" = EXCLUDED."last_seen_id", "updated_at" = NOW()
    `);
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
    } catch {}
  }
}

let _listener: PubSubListener | null = null;

export async function startListener(opts: ListenerOptions): Promise<PubSubListener> {
  if (_listener) return _listener;
  const listener = new PubSubListener(opts);
  _listener = listener;
  try {
    await listener.start();
    return listener;
  } catch (error) {
    if (_listener === listener) _listener = null;
    await listener.stop();
    throw error;
  }
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
