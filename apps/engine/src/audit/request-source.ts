import type { Context } from "hono";
import { logger } from "../logging/logger.ts";
import { type RequestSource, RequestSourceSchema } from "../observability/service-metadata.ts";

export function readRequestSource(c: Context): RequestSource | undefined {
  const raw = c.get("request_source") as unknown;
  const parsed = RequestSourceSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (raw !== undefined) {
    logger.debug({
      module: "audit",
      action: "request_source.rejected",
      msg: "trace-middleware set a request_source the audit schema does not recognise",
      raw: typeof raw === "string" ? raw : JSON.stringify(raw),
    });
  }
  return undefined;
}
