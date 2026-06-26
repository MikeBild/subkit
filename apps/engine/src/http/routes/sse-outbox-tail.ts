// Shared SSE tail over the transactional outbox (`events` table).
//
// Hand-rolled (outside the openapi() surface) because streamSSE
// commandeers the response — same precedent as GET /v1/events/stream
// (documented in docs/input-surfaces.md). On connect:
//
//   1. Replay. When the client supplied `Last-Event-ID`, replay every
//      row strictly after that id; otherwise flush recent history
//      (`replay: "recent"`) or the full match set (`replay: "all"`,
//      for bounded streams like a single execution).
//   2. Announce the current tail with a `hello` frame.
//   3. Poll the outbox every 250 ms for new rows. Cheap: the events
//      table is indexed on `(tenant_id, id)` and the query is always
//      `WHERE id > :cursor`.
//   4. Terminate on client disconnect (AbortSignal), or — when the
//      caller provides `closeAfter` — right after writing a row the
//      predicate marks as terminal (e.g. `execution.succeeded`), so
//      followers of a finished run exit instead of hanging.

import { and, asc, desc, gt, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Db } from "../../db/client.ts";
import { events } from "../../db/schema/index.ts";
import type { AppEnv } from "../openapi.ts";

export interface OutboxTailOptions {
  db: Db;
  /** Full WHERE conds, tenant filter included — rebuilt per query. */
  conds: () => SQL[];
  /** "recent" flushes the newest `replayLimit` rows; "all" replays the
   *  full ascending match set (bounded streams only). */
  replay: "recent" | "all";
  replayLimit?: number;
  /** Returns true for a row that ends the stream (written first). */
  closeAfter?: (row: { type: string; payload: unknown }) => boolean;
}

export function streamOutboxTail(c: Context<AppEnv>, opts: OutboxTailOptions): Response {
  const { db } = opts;
  const replayLimit = opts.replayLimit ?? 50;
  const lastHeader = c.req.header("last-event-id");
  const lastEventId = lastHeader ? Number.parseInt(lastHeader, 10) : null;

  return streamSSE(c, async (stream) => {
    let done = false;
    const write = async (row: { id: number; type: string; payload: unknown }) => {
      await stream.writeSSE({
        id: String(row.id),
        event: row.type,
        data: JSON.stringify(row.payload ?? {}),
      });
      if (opts.closeAfter?.(row)) done = true;
    };

    let cursor = 0;
    if (Number.isFinite(lastEventId) && lastEventId !== null && lastEventId >= 0) {
      const replay = await db
        .select()
        .from(events) // tenant-filter:exempt — conds() always includes the caller-supplied tenant predicate
        .where(and(...opts.conds(), gt(events.id, lastEventId)))
        .orderBy(asc(events.id))
        .limit(1_000);
      for (const row of replay) {
        await write(row);
        cursor = row.id;
      }
      if (cursor === 0) cursor = lastEventId;
    } else if (opts.replay === "all") {
      const replay = await db
        .select()
        .from(events) // tenant-filter:exempt — conds() always includes the caller-supplied tenant predicate
        .where(and(...opts.conds()))
        .orderBy(asc(events.id))
        .limit(1_000);
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
      data: JSON.stringify({ cursor }),
    });

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
      // Short poll cadence so live tests don't have to wait seconds
      // between ticks.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  });
}
