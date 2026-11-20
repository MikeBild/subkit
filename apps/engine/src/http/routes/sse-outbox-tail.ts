import type { SQL } from "drizzle-orm";
import type { Context } from "hono";
import type { Db } from "../../db/client.ts";
import {
  readOutboxAfter,
  readOutboxNewest,
  readOutboxNewestId,
  readOutboxOldest,
} from "../../webhooks/index.ts";
import type { AppEnv } from "../openapi.ts";
import { shutdownFrame, streamShutdownSignal } from "../stream-shutdown.ts";
import { streamTenantSSE as streamSSE } from "../tenant-stream.ts";

interface OutboxTailOptions {
  db: Db;
  conds: () => SQL[];
  replay: "recent" | "all" | "tail";
  replayLimit?: number;
  closeAfter?: (row: { type: string; payload: unknown }) => boolean;
  project?: (row: { type: string; payload: unknown }) => unknown | Promise<unknown>;
  hello?: Record<string, unknown>;
  viewerState?: () => Promise<Record<string, unknown>>;
  heartbeatMs?: number;
  onRows?: (rows: readonly { type: string }[]) => void;
  shutdown?: AbortSignal;
}

const OUTBOX_REPLAY_CAP = 1_000;
const OUTBOX_POLL_MS = 250;

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
      const payload = opts.project ? await opts.project(row) : row.payload;
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
      const replay = await readOutboxAfter(db, opts.conds(), lastEventId, OUTBOX_REPLAY_CAP);
      truncated = replay.length >= OUTBOX_REPLAY_CAP;
      if (replay.length > 0) opts.onRows?.(replay);
      for (const row of replay) {
        await write(row);
        cursor = row.id;
      }
      if (cursor === 0) cursor = lastEventId;
    } else if (opts.replay === "tail") {
      cursor = (await readOutboxNewestId(db, opts.conds())) ?? 0;
    } else if (opts.replay === "all") {
      const replay = await readOutboxOldest(db, opts.conds(), OUTBOX_REPLAY_CAP);
      for (const row of replay) {
        await write(row);
        cursor = row.id;
      }
    } else {
      const recent = await readOutboxNewest(db, opts.conds(), replayLimit);
      const ordered = recent.slice().reverse();
      for (const row of ordered) {
        await write(row);
        cursor = Math.max(cursor, row.id);
      }
    }

    await stream.writeSSE({
      event: "hello",
      data: JSON.stringify(
        opts.hello
          ? { cursor, ...opts.hello, ...((await opts.viewerState?.()) ?? {}), truncated }
          : { cursor },
      ),
    });
    lastWrite = Date.now();
    let lastState = lastWrite;

    const shutdown = opts.shutdown ?? streamShutdownSignal();
    const signal = AbortSignal.any([c.req.raw.signal, shutdown]);
    while (!signal.aborted && !done) {
      const newRows = await readOutboxAfter(db, opts.conds(), cursor, 200);
      if (newRows.length > 0) opts.onRows?.(newRows);
      for (const row of newRows) {
        await write(row);
        cursor = row.id;
        if (done) break;
      }
      if (done) break;
      const quietSince = opts.viewerState ? lastState : lastWrite;
      if (opts.heartbeatMs && Date.now() - quietSince >= opts.heartbeatMs) {
        await stream.writeSSE({
          event: "ping",
          data: JSON.stringify((await opts.viewerState?.()) ?? {}),
        });
        lastWrite = Date.now();
        lastState = lastWrite;
      }
      await pauseUnlessAborted(signal, OUTBOX_POLL_MS);
    }
    if (shutdown.aborted && !c.req.raw.signal.aborted && !done)
      await stream.writeSSE(shutdownFrame()).catch(() => {});
  });
}
