import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../openapi.ts";
import {
  cockpitInstallationRefusalFor,
  resolveCockpitInstallationContext,
} from "./cockpit-installation.ts";

export const INSTALLATION_SESSION_CHECK_MS = 3_000;
export const SESSION_ENDED_EVENT = "session.ended";
const COCKPIT_EVENT_STREAM = /\/v1\/cockpit\/events\/stream$/;

interface SessionStreamOptions {
  checkMs?: number;
  farewell?: () => Promise<Uint8Array | null>;
}

export function sessionEndedFrame(refusal: { status: number; code: string }): Uint8Array {
  return new TextEncoder().encode(
    `event: ${SESSION_ENDED_EVENT}\ndata: ${JSON.stringify({ status: refusal.status, code: refusal.code })}\n\n`,
  );
}

export function installationSessionStream(
  source: ReadableStream<Uint8Array>,
  active: () => Promise<boolean>,
  options: SessionStreamOptions = {},
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let canceled = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const end = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (canceled) return;
    canceled = true;
    clearInterval(timer);
    await reader.cancel().catch(() => {});
    try {
      const frame = options.farewell ? await options.farewell() : null;
      if (frame) controller.enqueue(frame);
    } catch {}
    try {
      controller.close();
    } catch {}
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (!options.checkMs) return;
        let checking = false;
        timer = setInterval(() => {
          if (checking || canceled) return;
          checking = true;
          active()
            .then((alive) => (alive ? undefined : end(controller)))
            .catch(() => {})
            .finally(() => {
              checking = false;
            });
        }, options.checkMs);
      },
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (canceled) return;
          if (chunk.done) {
            canceled = true;
            clearInterval(timer);
            controller.close();
            return;
          }
          if (!(await active())) {
            await end(controller);
            return;
          }
          if (!canceled) controller.enqueue(chunk.value);
        } catch (error) {
          if (!canceled) {
            canceled = true;
            clearInterval(timer);
            controller.error(error);
          }
        }
      },
      async cancel(reason) {
        canceled = true;
        clearInterval(timer);
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

export function guardCockpitInstallationStreams(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const source = c.res.body;
    if (!source || !c.res.headers.get("content-type")?.startsWith("text/event-stream")) return;
    const headers = new Headers(c.res.headers);
    headers.set("cache-control", "private, no-store");
    const db = c.get("db");
    const request = c.req.raw;
    const announces = COCKPIT_EVENT_STREAM.test(c.req.path);
    c.res = new Response(
      installationSessionStream(
        source,
        async () =>
          Boolean(await resolveCockpitInstallationContext(db, request, c.get("principal"))),
        {
          checkMs: INSTALLATION_SESSION_CHECK_MS,
          ...(announces
            ? {
                farewell: async () =>
                  sessionEndedFrame(await cockpitInstallationRefusalFor(db, request)),
              }
            : {}),
        },
      ),
      { status: c.res.status, statusText: c.res.statusText, headers },
    );
  };
}
