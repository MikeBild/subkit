import { and, asc, desc, gt, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Db } from "../../db/client.ts";
import { events } from "../../db/schema/index.ts";
import type { AppEnv } from "../openapi.ts";

export interface OutboxTailOptions {
  db: Db;
  conds: () => SQL[];
  replay: "recent" | "all" | "tail";
  replayLimit?: number;
  closeAfter?: (row: { type: string; payload: unknown }) => boolean;
  project?: (row: { type: string; payload: unknown }) => unknown;
  hello?: Record<string, unknown>;
  heartbeatMs?: number;
}

export const OUTBOX_REPLAY_CAP = 1_000;
export const OUTBOX_POLL_MS = 250;

type AbortListenerTarget = Pick<
  AbortSignal,
  "aborted" | "addEventListener" | "removeEventListener"
>;

export function pauseUnlessAborted(signal: AbortListenerTarget, ms: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", wake);
      resolve();
    }, ms);
    signal.addEventListener("abort", wake, { once: true });
  });
}

export function streamOutboxTail(c: Context<AppEnv>, opts: OutboxTailOptions): Response {
  const { db } = opts;
  const replayLimit = opts.replayLimit ?? 50;
  const lastHeader = c.req.header("last-event-id");
  const lastEventId = lastHeader ? Number.parseInt(lastHeader, 10) : null;

  return streamSSE(c, async (stream) => {
    let done = false;
    let lastWrite = Date.now();
    const write = async (row: { id: number; type: string; payload: unknown }) => {
      const payload = opts.project ? opts.project(row) : row.payload;
      await stream.writeSSE({
        id: String(row.id),
        event: row.type,
        data: JSON.stringify(payload ?? {}),
      });
      lastWrite = Date.now();
      if (opts.closeAfter?.(row)) done = true;
    };

    let cursor = 0;
    let truncated = false;
    if (Number.isFinite(lastEventId) && lastEventId !== null && lastEventId >= 0) {
      const replay = await db
        .select()
        .from(events) // tenant-filter:exempt — conds() always includes the caller-supplied tenant predicate
        .where(and(...opts.conds(), gt(events.id, lastEventId)))
        .orderBy(asc(events.id))
        .limit(OUTBOX_REPLAY_CAP);
      truncated = replay.length >= OUTBOX_REPLAY_CAP;
      for (const row of replay) {
        await write(row);
        cursor = row.id;
      }
      if (cursor === 0) cursor = lastEventId;
    } else if (opts.replay === "tail") {
      const [newest] = await db
        .select({ id: events.id })
        .from(events) // tenant-filter:exempt — conds() always includes the caller-supplied tenant predicate
        .where(and(...opts.conds()))
        .orderBy(desc(events.id))
        .limit(1);
      cursor = newest?.id ?? 0;
    } else if (opts.replay === "all") {
      const replay = await db
        .select()
        .from(events) // tenant-filter:exempt — conds() always includes the caller-supplied tenant predicate
        .where(and(...opts.conds()))
        .orderBy(asc(events.id))
        .limit(OUTBOX_REPLAY_CAP);
      for (const row of replay) {
        await write(row);
        cursor = row.id;
      }
    } else {
      const recent = await db
        .select()
        .from(events) // tenant-filter:exempt — conds() always includes the caller-supplied tenant predicate
        .where(and(...opts.conds()))
        .orderBy(desc(events.id))
        .limit(replayLimit);
      const ordered = recent.slice().reverse();
      for (const row of ordered) {
        await write(row);
        cursor = Math.max(cursor, row.id);
      }
    }

    await stream.writeSSE({
      event: "hello",
      data: JSON.stringify(opts.hello ? { cursor, ...opts.hello, truncated } : { cursor }),
    });
    lastWrite = Date.now();

    const signal = c.req.raw.signal;
    while (!signal.aborted && !done) {
      const newRows = await db
        .select()
        .from(events) // tenant-filter:exempt — conds() always includes the caller-supplied tenant predicate
        .where(and(...opts.conds(), gt(events.id, cursor)))
        .orderBy(asc(events.id))
        .limit(200);
      for (const row of newRows) {
        await write(row);
        cursor = row.id;
        if (done) break;
      }
      if (done) break;
      if (opts.heartbeatMs && Date.now() - lastWrite >= opts.heartbeatMs) {
        await stream.writeSSE({ event: "ping", data: "{}" });
        lastWrite = Date.now();
      }
      await pauseUnlessAborted(signal, OUTBOX_POLL_MS);
    }
  });
}
