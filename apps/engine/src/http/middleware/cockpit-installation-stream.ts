import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../openapi.ts";
import { resolveCockpitInstallationContext } from "./cockpit-installation.ts";

export function installationSessionStream(
  source: ReadableStream<Uint8Array>,
  active: () => Promise<boolean>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let canceled = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (canceled) return;
          if (chunk.done) {
            controller.close();
            return;
          }
          if (!(await active())) {
            canceled = true;
            await reader.cancel();
            controller.close();
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          if (!canceled) controller.error(error);
        }
      },
      async cancel(reason) {
        canceled = true;
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
    c.res = new Response(
      installationSessionStream(source, async () =>
        Boolean(
          await resolveCockpitInstallationContext(c.get("db"), c.req.raw, c.get("principal")),
        ),
      ),
      { status: c.res.status, statusText: c.res.statusText, headers },
    );
  };
}
