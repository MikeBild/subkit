// `subkit events tail`
//
// The engine exposes GET /v1/events (outbox tail) and the SSE stream at
// /v1/events/stream when available. For simplicity we poll the outbox
// every 2s and also attempt the SSE endpoint when requested.

import { readSse } from "@cli-core/index.ts";
import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";

const tailCmd = defineCommand({
  meta: { name: "tail", description: "Tail the outbox events" },
  args: {
    ...clientArgs,
    pattern: { type: "string", description: "Event pattern filter" },
    sse: { type: "boolean", description: "Use SSE stream instead of polling" },
  },
  async run({ args }) {
    const { client } = makeClient(args as Record<string, unknown>);
    if (args.sse) {
      const res = await client.stream("/v1/events/stream");
      if (!res.ok) {
        process.stderr.write(`stream error: ${res.status}\n`);
        process.exitCode = 2;
        return;
      }
      await readSse(res, (frame) => {
        process.stdout.write(`[${frame.event}] ${frame.data}\n`);
      });
      return;
    }
    let lastId = 0;
    const controller = new AbortController();
    const onInt = () => controller.abort();
    process.on("SIGINT", onInt);
    try {
      while (!controller.signal.aborted) {
        const body = await client.listEvents({ limit: 100 });
        const sorted = body.items
          .map((r) => r as { id: number; channel: string; type: string; payload: unknown })
          .sort((a, b) => a.id - b.id);
        for (const ev of sorted) {
          if (ev.id > lastId) {
            process.stdout.write(
              `${ev.id}\t${ev.channel}\t${ev.type}\t${JSON.stringify(ev.payload)}\n`,
            );
            lastId = ev.id;
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    } finally {
      process.removeListener("SIGINT", onInt);
    }
  },
});

export const eventsCommand = defineCommand({
  meta: { name: "events", description: "Outbox event tail" },
  subCommands: { tail: tailCmd },
});
