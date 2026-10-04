import { z } from "@hono/zod-openapi";

export const ConnectionStateEnum = z
  .enum(["valid", "expiring", "expired", "unreadable"])
  .openapi("ConnectionState");

export const ConnectionStateReasonEnum = z
  .enum(["refresh_refused", "refresh_failed", "expired_no_refresh", "secret_unreadable"])
  .openapi("ConnectionStateReason");

export const ConnectionSummarySchema = z
  .object({ id: z.string(), name: z.string(), state: ConnectionStateEnum })
  .openapi("ConnectionSummary");
